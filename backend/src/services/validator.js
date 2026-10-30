const config = require('../config');
const q = require('./queries');
const slack = require('./slack');
const { pool, uniq } = require('../utils/helpers');

/**
 * ProvisionStatus check for one side of the migration (source or destination).
 * A user is authenticated when ProvisionStatus has Provisioned = true under that side's AdminCloudId.
 * Returns Map<email, result>.
 */
async function checkProvisioning(ctx, emails, adminCloudId, role) {
  const list = uniq(emails.map(e => String(e).trim().toLowerCase()).filter(Boolean));
  const prov = list.length ? await q.findProvisionStatus(ctx.token, ctx.dbId, list, adminCloudId) : new Map();
  return new Map(list.map(email => {
    const p = prov.get(email);
    return [email, {
      role,
      email,
      adminCloudId: String(adminCloudId),
      cloudName: p?.cloudName || '',
      inProvisionStatus: !!p,
      emailSent: !!p?.emailSent,
      provisioned: !!p?.provisioned,
      authenticated: !!p?.provisioned,
      reason: !p ? 'Not found in ProvisionStatus for this AdminCloudId'
        : p.provisioned ? 'Provisioned' : 'Not provisioned (Provisioned is false)',
    }];
  }));
}

/**
 * Slack token check (auth.test) for source users: Clouds → CloudUserId → CFOAuthCredentials → auth.test.
 * Only clouds whose cloudName is SLACK are sent to Slack.
 * Returns Map<email, tokenResult>. Results never include the access token.
 *
 * opts.userId:       only clouds owned by this Users._id (JSON approach)
 * opts.statusGate:   only clouds whose [cloudStatus, billingStatus] is in config.jsonApproach.checkedStatuses
 *                    are sent to Slack; others are "Not called" with their statuses as the reason
 * opts.onApiCall:    called for every HTTP request to Slack and every rate-limited answer (see slack.authTest)
 */
async function checkSlackTokens(ctx, emails, adminCloudId, onProgress = () => {}, opts = {}) {
  const { token, dbId } = ctx;
  const results = new Map();
  const list = uniq(emails);
  if (!list.length) return results;
  const norm = v => String(v ?? '').trim().toUpperCase();
  const allowed = new Set(config.jsonApproach.checkedStatuses.map(([c, b]) => `${c}|${b}`));

  // The user's cloud under this admin cloud, preferring a SLACK cloud
  const cloudOf = new Map();
  for (const c of await q.findCloudsByEmails(token, dbId, list)) {
    if (c.adminCloudId !== String(adminCloudId)) continue;
    if (opts.userId && c.userId && c.userId !== String(opts.userId)) continue;
    const cur = cloudOf.get(c.email);
    if (!cur || (!slack.isSlackCloud(cur.cloudName) && slack.isSlackCloud(c.cloudName))) cloudOf.set(c.email, c);
  }

  const eligible = [];
  for (const email of list) {
    const c = cloudOf.get(email);
    const r = {
      email, cloudUserId: c?.cloudUserId || '', tokenFound: false, apiCalled: false,
      tokenValid: false, slackError: '', slackUserId: '', slackTeam: '', tokenCheck: '',
      cloudStatus: c ? norm(c.cloudStatus) : '', billingStatus: c ? norm(c.billingStatus) : '',
    };
    if (!c) r.tokenCheck = 'Not called: no cloud under this admin cloud';
    else if (!slack.isSlackCloud(c.cloudName)) r.tokenCheck = `Not called: cloud is ${c.cloudName || 'unknown'}, not SLACK`;
    else if (/^DEACTIVAT/.test(r.billingStatus)) {
      // Billing deactivated: no auth.test call; the caller decides from ProvisionStatus instead
      r.billingDeactivated = true;
      r.tokenCheck = 'Not called: billingStatus DEACTIVATED (ProvisionStatus used)';
    } else if (opts.statusGate && !allowed.has(`${r.cloudStatus}|${r.billingStatus}`)) {
      r.tokenCheck = `Not called: cloudStatus ${r.cloudStatus || '(none)'} / billingStatus ${r.billingStatus || '(none)'} is not checked`;
    } else eligible.push(r);
    results.set(email, r);
  }

  const tokens = await q.findAccessTokens(token, dbId, eligible.map(r => r.cloudUserId));
  let done = 0;
  onProgress({ done, total: eligible.length });
  await pool(eligible, Number(process.env.SLACK_CONCURRENCY || 5), async r => {
    let accessToken = tokens.get(r.cloudUserId);
    // If tokens are encrypted at rest, decrypt here:  accessToken = decrypt(accessToken)
    if (!accessToken) {
      r.tokenCheck = 'Not called: no AccessToken in CFOAuthCredentials';
    } else {
      r.tokenFound = true;
      const t = await slack.authTest(accessToken, cloudOf.get(r.email).cloudName, opts.onApiCall);
      r.apiCalled = !t.skipped && !t.transient;
      r.tokenValid = t.authenticated;
      r.slackError = t.error || '';
      r.slackUserId = t.slackUserId || '';
      r.slackTeam = t.team || '';
      // A rate limit or outage that outlasted the retries says nothing about the token: report it as unchecked
      r.transient = !!t.transient;
      r.tokenCheck = t.authenticated ? 'Valid'
        : t.transient ? `Not checked: Slack ${t.error === 'ratelimited' ? 'rate limit' : `unavailable (${t.error})`} after retries; rerun to check`
          : `Invalid: ${t.error}`;
    }
    accessToken = null;
    onProgress({ done: ++done, total: eligible.length });
  });

  return results;
}

module.exports = { checkProvisioning, checkSlackTokens };
