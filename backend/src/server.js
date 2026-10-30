require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const routes = require('./routes');
const mb = require('./services/metabase');
const { jobStore } = require('./services/store');
const { PrunedMemoryStore } = require('./sessionStore');
const { securityHeaders, sameOrigin, allowedHosts, isLoopback, rateLimit } = require('./security');

// Listens on this machine only unless HOST says otherwise (e.g. HOST=0.0.0.0 behind a proxy)
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
const secureCookies = process.env.COOKIE_SECURE === 'true';
// Behind an HTTPS proxy, trust it so secure cookies and req.ip work. TRUST_PROXY may be true (one hop),
// a hop count, or Express's list form ("loopback", "10.0.0.5", ...). Only set it when a proxy is in front:
// otherwise clients can fake their IP with X-Forwarded-For.
const trustProxy = String(process.env.TRUST_PROXY || '').trim();
if (trustProxy && trustProxy !== 'false') app.set('trust proxy', trustProxy === 'true' ? 1 : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
else if (secureCookies) app.set('trust proxy', 1);

// For load balancers and uptime checks, which often call by IP: answered before the host-name check
app.get('/healthz', (req, res) => res.json({ ok: true, runningChecks: jobStore.running() }));

// Host names this server answers to: this machine, plus ALLOWED_HOSTS (the public name on a server)
const extraHosts = String(process.env.ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean);
if (!isLoopback(HOST) && !extraHosts.length) {
  console.warn(`HOST=${HOST} lets other machines connect, but ALLOWED_HOSTS is not set: only localhost:${PORT} is answered. Set ALLOWED_HOSTS to the name users open (e.g. dmauth.example.com).`);
}
app.use(allowedHosts([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, ...extraHosts]));
app.use(securityHeaders);
app.use(express.json({ limit: '10mb' })); // an uploaded mapping CSV is sent with the job request

const secret = process.env.SESSION_SECRET || '';
const weakSecret = secret.length < 32 || /change-me/i.test(secret);
if (weakSecret && !isLoopback(HOST)) {
  console.error('SESSION_SECRET must be a random string of 32+ characters when the server is reachable from other machines. '
    + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
if (!secret) console.warn('SESSION_SECRET not set; sessions will reset on restart.');
else if (weakSecret) console.warn('SESSION_SECRET is weak; use a long random string (32+ characters).');

// Sessions live in memory and expire after 8 hours; a dropped session closes its Metabase session and its checks
const sessionStore = new PrunedMemoryStore({
  max: Number(process.env.MAX_SESSIONS || 2000),
  onRemove: (sid, sess) => {
    jobStore.removeOwner(sid);
    if (sess?.mbToken) mb.logout(sess.mbToken);
  },
});
app.use(session({
  name: 'dmauth.sid',
  secret: secret || crypto.randomBytes(32).toString('hex'),
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    maxAge: 8 * 3600 * 1000,
  },
}));

// Every API call: CSRF guard for writes, and a general cap. Signed-in users are counted per session,
// so colleagues behind one office IP don't share a limit; anyone else is counted per IP.
app.use('/api', sameOrigin);
app.use('/api', rateLimit({
  windowMs: 60 * 1000, max: 600, key: req => (req.session?.mbToken ? `s:${req.sessionID}` : `ip:${req.ip}`),
  message: 'Too many requests; wait a minute and try again',
}));
app.use('/api', routes);
app.use(express.static(path.join(__dirname, '..', 'public'), { dotfiles: 'ignore' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Unexpected error' : err.message || 'Unexpected error' });
});

if (process.env.METABASE_API_KEY && !isLoopback(HOST) && !process.env.APP_PASSWORD) {
  console.warn('METABASE_API_KEY is set and the server is reachable from other machines, but APP_PASSWORD is not set: sign-in is refused until APP_PASSWORD is set.');
}
const server = app.listen(PORT, HOST, () => console.log(`DM auth automation running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));

// Stop cleanly when the service manager (systemd, pm2, Docker) asks: finish open requests, then exit
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down (${jobStore.running()} checks still running are lost)`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
