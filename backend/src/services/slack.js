const { sleep } = require('../utils/helpers');

/** True when a Clouds.cloudName is Slack ("SLACK", "Slack", " slack "). */
const isSlackCloud = cloudName => String(cloudName ?? '').toUpperCase().replace(/[\s_-]/g, '') === 'SLACK';

const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 15000;
const MAX_WAIT_S = 120;

// Shared pause: when Slack answers 429, every call (not only the one that hit it) waits until
// Retry-After has passed, so the parallel workers don't keep the limit tripped.
let pausedUntil = 0;
const backoff = attempt => sleep(1000 * 2 ** (attempt - 1)); // 1 s, 2 s, 4 s, …

/**
 * Step 7: POST https://slack.com/api/auth.test with the user's token.
 * Only called for clouds whose cloudName is SLACK; any other cloud is skipped without a request.
 * Rate limits (429, or error "ratelimited"), Slack 5xx errors, timeouts and network errors are retried.
 * If they persist, the result has `transient: true`: the token wasn't judged, so it must not be
 * reported as invalid or cached.
 * onRequest(event) is called for every HTTP request sent to Slack ('request', retries included)
 * and for every rate-limited answer ('ratelimited'), so callers can count API calls.
 * Returns { authenticated, slackUserId, team, teamId, error, skipped, transient }. Never returns the token.
 */
async function authTest(accessToken, cloudName, onRequest = () => {}) {
  if (!isSlackCloud(cloudName)) {
    return { authenticated: false, skipped: true, error: `not_slack_cloud (${cloudName || 'unknown'})` };
  }
  for (let attempt = 1; ; attempt++) {
    const paused = pausedUntil - Date.now();
    if (paused > 0) await sleep(paused);

    let res;
    onRequest('request');
    try {
      res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) { await backoff(attempt); continue; }
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      return { authenticated: false, transient: true, error: timedOut ? 'timeout' : `network_error: ${e.message}` };
    }

    let body;
    try { body = await res.json(); } catch { body = { ok: false, error: `http_${res.status}` }; }

    if (res.status === 429 || body.error === 'ratelimited') {
      onRequest('ratelimited');
      const header = res.headers.get('retry-after');
      const seconds = Math.min(header != null && header !== '' && !Number.isNaN(Number(header)) ? Number(header) : 2 * attempt, MAX_WAIT_S);
      pausedUntil = Math.max(pausedUntil, Date.now() + seconds * 1000);
      if (attempt < MAX_ATTEMPTS) continue;
      return { authenticated: false, transient: true, error: 'ratelimited' };
    }
    if (res.status >= 500) {
      if (attempt < MAX_ATTEMPTS) { await backoff(attempt); continue; }
      return { authenticated: false, transient: true, error: `http_${res.status}` };
    }

    if (body.ok) {
      return {
        authenticated: true,
        slackUserId: body.user_id,
        slackUser: body.user,
        team: body.team,
        teamId: body.team_id,
        error: '',
      };
    }
    // token_revoked, invalid_auth, account_inactive, not_authed, ...
    return { authenticated: false, error: body.error || 'User not found' };
  }
}

module.exports = { authTest, isSlackCloud };
