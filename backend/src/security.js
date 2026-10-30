const crypto = require('crypto');

/**
 * Browser hardening for every response. The page has no inline scripts or styles, so the
 * Content-Security-Policy can stay strict; the only outside sources are Google Fonts.
 */
function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // API answers (results, CSVs) hold customer data: don't let browsers or proxies keep them
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * CSRF guard for requests that change state: the browser's Origin (or Referer) must be this server.
 * Requests without either header (curl, server-to-server) are allowed; browsers always send one on POST.
 */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const from = req.get('origin') || req.get('referer');
  if (!from) return next();
  let host;
  try { host = new URL(from).host; } catch { host = null; }
  if (host && host === req.get('host')) return next();
  return res.status(403).json({ error: 'Request blocked: it did not come from this app' });
}

/**
 * DNS rebinding guard: only answer requests whose Host header names this server. Without it, a page on
 * another domain that resolves to this machine passes sameOrigin (its Origin and Host match each other).
 * Entries are "name" (any port) or "name:port", compared case-insensitively.
 */
function allowedHosts(list) {
  const allowed = list.map(h => String(h).trim().toLowerCase()).filter(Boolean);
  return (req, res, next) => {
    const host = String(req.get('host') || '').toLowerCase();
    let name;
    try { name = host ? new URL(`http://${host}`).hostname : null; } catch { name = null; }
    if (name && allowed.some(a => a === host || a === name)) return next();
    return res.status(421).json({ error: 'Request blocked: unknown host name' });
  };
}

/** True when HOST only listens on this machine (127.0.0.1 is the default). */
const isLoopback = host => ['127.0.0.1', 'localhost', '::1'].includes(String(host || '127.0.0.1').toLowerCase());

/**
 * Fixed-window rate limiter kept in memory. `key(req)` picks the bucket (IP, session, …).
 * Answers 429 with Retry-After once `max` requests have been made in `windowMs`.
 */
function rateLimit({ windowMs, max, key, message }) {
  const hits = new Map(); // bucket -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + windowMs }; hits.set(k, h); }
    h.count += 1;
    if (h.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

/** Constant-time string comparison, so a password check doesn't leak how much of it matched. */
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = { securityHeaders, sameOrigin, allowedHosts, isLoopback, rateLimit, safeEqual };
