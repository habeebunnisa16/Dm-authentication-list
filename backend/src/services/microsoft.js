const crypto = require('crypto');
const { safeEqual } = require('../security');

/**
 * "Sign in with Microsoft" (Entra ID): the first gate, in front of the Metabase sign-in. It proves the person
 * has a work account in our tenant; Metabase access still comes from their own Metabase login.
 * Authorization-code flow with PKCE and a client secret. The id_token is read straight from Microsoft's token
 * endpoint over TLS, which is why its signature isn't re-checked (OpenID Connect Core 3.1.3.7); its claims are.
 */
class MsError extends Error {
  // code is what the page shows: denied (cancelled), expired (state or time), domain, failed
  constructor(code, message) { super(message); this.code = code; }
}

const env = k => String(process.env[k] || '').trim();
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_MS = 10 * 60 * 1000;
const b64u = buf => Buffer.from(buf).toString('base64url');

const enabled = () => !!(env('MS_TENANT_ID') && env('MS_CLIENT_ID') && env('MS_CLIENT_SECRET'));
const domain = () => (env('MS_ALLOWED_DOMAIN') || 'cloudfuze.com').toLowerCase().replace(/^@/, '');
const authority = () => `https://login.microsoftonline.com/${encodeURIComponent(env('MS_TENANT_ID'))}`;
const redirectUri = () => env('MS_REDIRECT_URI') || `http://localhost:${Number(process.env.PORT || 4000)}/api/auth/microsoft/callback`;

/** The Microsoft sign-in URL, plus what the callback must find again (kept in the session, never sent to the browser). */
function begin() {
  const state = b64u(crypto.randomBytes(24));
  const nonce = b64u(crypto.randomBytes(24));
  const verifier = b64u(crypto.randomBytes(48));
  const url = new URL(`${authority()}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: env('MS_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), pending: { state, nonce, verifier, at: Date.now() } };
}

/** Checks the id_token claims and returns the signed-in person. Throws MsError. */
function checkClaims(claims, nonce) {
  const tenant = env('MS_TENANT_ID').toLowerCase();
  if (!GUID_RE.test(tenant)) throw new MsError('failed', 'MS_TENANT_ID must be the tenant ID (a GUID), not a domain name');
  if (claims.aud !== env('MS_CLIENT_ID')) throw new MsError('failed', 'id_token was issued for another application');
  if (String(claims.tid || '').toLowerCase() !== tenant) throw new MsError('domain', 'Account is not in this tenant');
  if (claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) throw new MsError('failed', 'id_token has an unexpected issuer');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() - 60 * 1000) throw new MsError('expired', 'id_token has expired');
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) throw new MsError('failed', 'id_token nonce does not match');
  const email = String(claims.preferred_username || claims.email || '').trim().toLowerCase();
  if (!email.endsWith(`@${domain()}`)) throw new MsError('domain', `Account ${email || '(no email)'} is not an @${domain()} account`);
  return { email, name: String(claims.name || email), oid: String(claims.oid || '') };
}

/** Finishes the sign-in: `query` is the callback's query string, `pending` what begin() returned. */
async function complete(query, pending) {
  if (!pending || Date.now() - pending.at > PENDING_MS) throw new MsError('expired', 'No sign-in in progress, or it took too long');
  if (typeof query.state !== 'string' || !safeEqual(query.state, pending.state)) throw new MsError('expired', 'State does not match');
  if (query.error) throw new MsError('denied', `Microsoft returned ${String(query.error).slice(0, 60)}`);
  if (typeof query.code !== 'string' || !query.code || query.code.length > 4096) throw new MsError('failed', 'No authorization code');
  let res, body;
  try {
    res = await fetch(`${authority()}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env('MS_CLIENT_ID'),
        client_secret: env('MS_CLIENT_SECRET'),
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: redirectUri(),
        code_verifier: pending.verifier,
      }),
      signal: AbortSignal.timeout(20000),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    throw new MsError('failed', `Cannot reach Microsoft: ${e.message}`);
  }
  if (!res.ok || typeof body.id_token !== 'string') throw new MsError('failed', `Microsoft token request failed: ${body.error || res.status}`);
  let claims;
  try { claims = JSON.parse(Buffer.from(body.id_token.split('.')[1] || '', 'base64url').toString('utf8')); } catch { claims = null; }
  if (!claims || typeof claims !== 'object') throw new MsError('failed', 'id_token could not be read');
  return checkClaims(claims, pending.nonce);
}

module.exports = { MsError, enabled, domain, redirectUri, begin, complete, checkClaims };
