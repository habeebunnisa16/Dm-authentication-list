const express = require('express');
const config = require('./config');
const mb = require('./services/metabase');
const q = require('./services/queries');
const schema = require('./services/schema');
const { jobStore } = require('./services/store');
const { runReport, runJsonReport, runDmList } = require('./services/pipeline');
const { authMatrix, CODE_VERSIONS, codeVersionOf } = require('./services/rules');
const { toCsv } = require('./utils/helpers');
const { rateLimit, safeEqual, isLoopback } = require('./security');

const router = express.Router();

// Sign-in attempts: slows down password guessing. Counted per account, plus a looser cap per IP so a
// whole office behind one IP can still sign in. The app password (API-key mode) has no account, so per IP.
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  key: req => (process.env.METABASE_API_KEY ? `ip:${req.ip}` : `user:${String(req.body?.username || '').trim().toLowerCase()}`),
  message: 'Too many sign-in attempts; wait 15 minutes and try again',
});
const loginIpLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100, key: req => req.ip,
  message: 'Too many sign-in attempts from this network; wait 15 minutes and try again',
});
// Checks started per session: each one runs many Metabase queries and Slack calls
const jobLimit = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, key: req => req.sessionID,
  message: 'Too many checks started this hour; wait a while and try again',
});
const MAX_RUNNING_JOBS = 2;
// Checks running at once across every user: each one runs many Metabase queries and Slack calls
const MAX_RUNNING_TOTAL = () => Number(process.env.MAX_RUNNING_CHECKS || 8);
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireAuth(req, res, next) {
  if (!req.session.mbToken) return res.status(401).json({ error: 'Sign in to Metabase first' });
  next();
}
const ctx = req => ({ token: req.session.mbToken });
const dbIdOf = v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new mb.HttpError(400, 'Choose a database first');
  return n;
};

// ---------- Step 1: connect to Metabase ----------
router.get('/auth/me', (req, res) => {
  res.json({
    signedIn: !!req.session.mbToken,
    user: req.session.mbUser || null,
    metabaseUrl: process.env.METABASE_URL,
    apiKeyMode: !!process.env.METABASE_API_KEY,
    codeVersion: codeVersionOf(req.session.codeVersion),
    // In API-key mode with APP_PASSWORD set, the Connect form asks for that password
    appPassword: !!process.env.METABASE_API_KEY && !!process.env.APP_PASSWORD,
  });
});

router.post('/auth/login', loginIpLimit, loginLimit, ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (process.env.METABASE_API_KEY) {
    // The API key signs everyone in as the same Metabase user, so the app itself needs a password
    if (!process.env.APP_PASSWORD && !isLoopback(process.env.HOST)) {
      return res.status(503).json({ error: 'APP_PASSWORD must be set in .env before this server can be used from other machines' });
    }
    if (process.env.APP_PASSWORD && !safeEqual(password || '', process.env.APP_PASSWORD)) {
      return res.status(401).json({ error: 'Wrong app password' });
    }
  } else if (!username || !password) {
    return res.status(400).json({ error: 'Enter your Metabase email and password' });
  }
  if (username && (typeof username !== 'string' || username.length > 320)) return res.status(400).json({ error: 'Invalid email' });
  if (password && (typeof password !== 'string' || password.length > 1000)) return res.status(400).json({ error: 'Invalid password' });
  const token = await mb.login(username, password);
  const me = await mb.currentUser(token).catch(() => ({ email: username }));
  // Signing in as another account: close the previous Metabase session first
  if (req.session.mbToken && req.session.mbToken !== token) await mb.logout(req.session.mbToken);
  await new Promise((resolve, reject) => req.session.regenerate(err => (err ? reject(err) : resolve())));
  {
    req.session.mbToken = token;
    req.session.mbUser = { email: me.email, name: me.common_name || me.first_name || me.email };
    // Old code or new code, chosen on the Connect page: decides which side needs authentication
    req.session.codeVersion = codeVersionOf(req.body?.codeVersion);
    res.json({ ok: true, user: req.session.mbUser, codeVersion: req.session.codeVersion });
  }
}));

// JSON approach: the user's finished DMTODM exports (ExportChannelsQueue), newest first
router.get('/exports', requireAuth, ah(async (req, res) => {
  const dbId = dbIdOf(req.query.dbId);
  const userId = String(req.query.userId || '').trim();
  if (!userId || userId.length > 200) return res.status(400).json({ error: 'Choose the user first' });
  res.json({ exports: await q.findExports(ctx(req).token, dbId, userId) });
}));

// Switch between old code and new code without signing out (applies to checks started afterwards)
router.post('/settings/code-version', requireAuth, (req, res) => {
  const v = req.body?.codeVersion;
  if (!CODE_VERSIONS.includes(v)) return res.status(400).json({ error: 'codeVersion must be "old" or "new"' });
  req.session.codeVersion = v;
  res.json({ ok: true, codeVersion: v });
});

router.post('/auth/logout', ah(async (req, res) => {
  await mb.logout(req.session.mbToken);
  req.session.destroy(() => {
    res.clearCookie('dmauth.sid');
    res.json({ ok: true });
  });
}));

// ---------- Step 1.ii: databases ----------
router.get('/databases', requireAuth, ah(async (req, res) => {
  res.json({ databases: await mb.listDatabases(req.session.mbToken) });
}));

// Diagnostics: real collection and field names vs config.js
router.get('/schema/:dbId', requireAuth, ah(async (req, res) => {
  const dbId = dbIdOf(req.params.dbId);
  schema.clearCache(req.session.mbToken, dbId);
  res.json(await schema.describe(req.session.mbToken, dbId));
}));

router.get('/cloud-types', (req, res) => res.json({
  cloudTypes: config.cloudTypes,
  authRules: authMatrix(config.cloudTypes.map(t => t.value), 'old'),
  authRulesByVersion: Object.fromEntries(CODE_VERSIONS.map(v => [v, authMatrix(config.cloudTypes.map(t => t.value), v)])),
  dmTypes: config.dmTypes,
}));

// ---------- Step 1.1: every Users document (_id + PrimaryEmailId) for the user picker ----------
router.get('/users', requireAuth, ah(async (req, res) => {
  const dbId = dbIdOf(req.query.dbId);
  res.json(await q.listUsers(ctx(req).token, dbId));
}));

// ---------- Step 1.2: Users._id (picked) or Users.PrimaryEmailId (typed) → Clouds with that UserId and IsAdmin = true ----------
router.post('/admin-clouds', requireAuth, ah(async (req, res) => {
  const dbId = dbIdOf(req.body.dbId);
  const userId = String(req.body.userId || '').trim();
  const email = String(req.body.email || '').trim();
  if (userId) {
    const picked = await q.findUserById(ctx(req).token, dbId, userId);
    if (!picked) return res.status(404).json({ error: `No user found with _id ${userId}` });
    return res.json({ user: picked, clouds: await q.findAdminClouds(ctx(req).token, dbId, picked.id) });
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });

  const user = await q.findUserByEmail(ctx(req).token, dbId, email);
  if (!user) {
    const d = await schema.describe(ctx(req).token, dbId).catch(() => null);
    const u = d?.collections.users;
    let why = '';
    if (d && !u.found) {
      why = ` The collection "${u.configured}" was not found in ${d.database}. Collections here: ${d.allCollections.slice(0, 40).join(', ')}.`;
    } else if (d && !u.fields.primaryEmail.found) {
      const mailish = u.allFields.filter(f => /mail/i.test(f));
      why = ` Field "${u.fields.primaryEmail.configured}" not found in ${u.found}. Email-like fields: ${mailish.join(', ') || 'none'}.`;
    } else if (d) {
      why = ` Searched ${u.found}.${u.fields.primaryEmail.found} in database ${d.database}. Check you picked the right project.`;
    }
    return res.status(404).json({ error: `No user found for ${email}.${why}` });
  }

  const clouds = await q.findAdminClouds(ctx(req).token, dbId, user.id);
  res.json({ user, clouds });
}));

// ---------- Steps 3/5: permission cache ----------
router.post('/permission-cache', requireAuth, ah(async (req, res) => {
  const dbId = dbIdOf(req.body.dbId);
  const { sourceAdminCloudId, destAdminCloudId } = req.body;
  if (!sourceAdminCloudId || !destAdminCloudId) return res.status(400).json({ error: 'Choose a source and a destination cloud' });
  const rows = await q.findPermissionCache(ctx(req).token, dbId, String(sourceAdminCloudId), String(destAdminCloudId));
  let warning = '';
  if (!rows.length) {
    const { C, F, schema: sc } = await schema.resolveNames(ctx(req).token, dbId);
    const f = F.permissionCache;
    const count = async match => (await mb.runMongo(ctx(req).token, dbId, C.permissionCache, [{ $match: match }, { $count: 'n' }]))[0]?.n || 0;
    const bySource = await count({ [f.sourceAdminCloudId]: String(sourceAdminCloudId) }).catch(() => '?');
    const byBoth = await count({ [f.sourceAdminCloudId]: String(sourceAdminCloudId), [f.destAdminCloudId]: String(destAdminCloudId) }).catch(() => '?');
    warning = `0 rows. Searched ${C.permissionCache} using fields ${f.sourceAdminCloudId}, ${f.destAdminCloudId}, ${f.isMapped}. `
      + `Rows matching source cloud only: ${bySource}; source + destination: ${byBoth}.`
      + (sc.error ? ` Metabase metadata could not be read (${sc.error}), so names from config.js were used as-is.` : '');
  } else if (!rows.some(r => r.sourceEmail)) {
    const d = await schema.describe(ctx(req).token, dbId).catch(() => null);
    const pc = d?.collections.permissionCache;
    warning = `No source emails found. Fields in ${pc?.found || 'PermissionCache'}: ${(pc?.allFields || []).join(', ')}. `
      + `Set permissionCache.sourceEmail in config.js to the email field and restart.`;
  }
  res.json({ rows, count: rows.length, warning });
}));

router.post('/permission-cache/csv', requireAuth, ah(async (req, res) => {
  const dbId = dbIdOf(req.body.dbId);
  const rows = await q.findPermissionCache(ctx(req).token, dbId, String(req.body.sourceAdminCloudId), String(req.body.destAdminCloudId));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="permission_cache.csv"');
  res.send(toCsv(rows, [
    { key: 'isMapped', label: 'IsMapped' },
    { key: 'sourceEmail', label: 'SourceEmail' },
    { key: 'destEmail', label: 'DestEmail' },
  ]));
}));

// ---------- Check users' authentication, then their SlackDms (any combination) ----------
router.post('/jobs', requireAuth, jobLimit, ah(async (req, res) => {
  if (jobStore.running(req.sessionID) >= MAX_RUNNING_JOBS) {
    return res.status(429).json({ error: `${MAX_RUNNING_JOBS} checks are already running; wait for one to finish` });
  }
  if (jobStore.running() >= MAX_RUNNING_TOTAL()) {
    res.setHeader('Retry-After', '60');
    return res.status(503).json({ error: 'The server is busy with other users\' checks; try again in a minute' });
  }
  const dbId = dbIdOf(req.body.dbId);
  const { adminUserId, sourceAdminCloudId, destAdminCloudId } = req.body;
  const types = config.cloudTypes.map(t => t.value);
  const sourceType = String(req.body.sourceType || '').toUpperCase();
  const destType = String(req.body.destType || '').toUpperCase();
  if (!types.includes(sourceType) || !types.includes(destType)) {
    return res.status(400).json({ error: 'Choose a source and a destination type' });
  }
  if (String(sourceAdminCloudId) === String(destAdminCloudId)) {
    return res.status(400).json({ error: 'Source and destination must be different clouds' });
  }
  // Confirm both clouds really belong to this admin before running
  const clouds = await q.findAdminClouds(ctx(req).token, dbId, String(adminUserId));
  const ids = new Set(clouds.map(c => c.cloudId));
  if (!ids.has(String(sourceAdminCloudId)) || !ids.has(String(destAdminCloudId))) {
    return res.status(400).json({ error: 'The selected clouds are not admin clouds of this user' });
  }

  // JSON approach (Export channel info): Slack source only, from the chosen DMTODM exports
  // Export-JSON: 'json' = Delta-validation (MessageWorkSpace), 'onetime' = OneTime-Migration (ExportChannelInfo)
  const json = req.body.mode === 'json';
  const oneTime = req.body.mode === 'onetime' || req.body.dmSource === 'onetime';
  // Auth users DM list in one go: check the users, then build the DM list from this source
  const dmSource = ['api', 'onetime', 'delta'].includes(req.body.dmSource) ? req.body.dmSource : null;
  let sessionIds = null;
  if (json || oneTime || dmSource === 'delta') {
    if (sourceType !== 'SLACK') return res.status(400).json({ error: 'Export-JSON is only for a Slack source' });
    if (!Array.isArray(req.body.sessionIds) || !req.body.sessionIds.length || req.body.sessionIds.length > 500) {
      return res.status(400).json({ error: 'Choose one or more exports' });
    }
    sessionIds = [...new Set(req.body.sessionIds.map(v => String(v ?? '').trim()).filter(v => v && v.length <= 200))];
    if (!sessionIds.length) return res.status(400).json({ error: 'Choose one or more exports' });
  }

  // Optional uploaded mapping: replaces PermissionCache as the list of source → destination users
  let mapping = null;
  if (req.body.mapping != null) {
    if (!Array.isArray(req.body.mapping) || req.body.mapping.length > 100000) {
      return res.status(400).json({ error: 'The uploaded mapping must be a list of at most 100,000 rows' });
    }
    const clean = v => String(v ?? '').trim().toLowerCase();
    mapping = req.body.mapping
      .map(r => ({ sourceEmail: clean(r?.sourceEmail), destEmail: clean(r?.destEmail) }))
      .filter(r => EMAIL_RE.test(r.sourceEmail) && (!r.destEmail || EMAIL_RE.test(r.destEmail)));
    if (!mapping.length) return res.status(400).json({ error: 'The uploaded mapping has no rows with a valid source email' });
  }

  // Which sides are checked follows services/rules.js; Slack sides are checked with auth.test
  const job = jobStore.create(req.sessionID, {
    dbId, adminUserId: String(adminUserId), sourceType, destType, codeVersion: codeVersionOf(req.session.codeVersion),
    sourceAdminCloudId: String(sourceAdminCloudId), destAdminCloudId: String(destAdminCloudId),
    mapping, mappingSource: mapping ? 'Uploaded CSV' : 'PermissionCache',
    mode: json ? 'json' : oneTime ? 'onetime' : 'api', sessionIds, dmSource,
    // "Re-run check": ignore the token-check cache and ask Slack again for every user
    fresh: req.body.fresh === true,
    // Token-check cache per Metabase user, so results only reach users whose own permissions produced them.
    // In API-key mode everyone is the same Metabase user, so the cache is shared.
    cacheOwner: process.env.METABASE_API_KEY ? '' : String(req.session.mbUser?.email || req.sessionID),
  });
  (json ? runJsonReport : runReport)(ctx(req), job); // runs in background; client polls
  res.status(202).json({ jobId: job.id });
}));

router.get('/jobs/:id', requireAuth, (req, res) => {
  const job = jobStore.get(req.params.id, req.sessionID);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  const { sourceType, destType, sourceAdminCloudId, destAdminCloudId, mappingSource, codeVersion, mode } = job.params;
  res.json({
    id: job.id, status: job.status, steps: job.steps, summary: job.summary, error: job.error, dmError: job.dmError || null,
    slackApi: job.slackApi || null,
    rerun: !!job.params.fresh,
    params: { sourceType, destType, sourceAdminCloudId, destAdminCloudId, mappingSource, codeVersion, mode, exports: job.params.sessionIds?.length || 0 },
  });
});

// Auth users DM list for another DM source, built from the users this check already authenticated
// (no new Slack or ProvisionStatus calls): api = SlackDms, onetime = ExportChannelInfo, delta = MessageWorkSpace
router.post('/jobs/:id/dm-list', requireAuth, (req, res) => {
  const job = jobStore.get(req.params.id, req.sessionID);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  if (job.status !== 'done' || !job.ctx) return res.status(409).json({ error: 'Run the Auth users list first and wait for it to finish' });
  const source = req.body?.source;
  if (!['api', 'onetime', 'delta'].includes(source)) return res.status(400).json({ error: 'source must be api, onetime or delta' });
  let sessionIds = [];
  if (source !== 'api') {
    if (job.params.sourceType !== 'SLACK') return res.status(400).json({ error: 'Export-JSON is only for a Slack source' });
    if (!Array.isArray(req.body.sessionIds) || !req.body.sessionIds.length || req.body.sessionIds.length > 500) {
      return res.status(400).json({ error: 'Choose one or more exports' });
    }
    sessionIds = [...new Set(req.body.sessionIds.map(v => String(v ?? '').trim()).filter(v => v && v.length <= 200))];
    if (!sessionIds.length) return res.status(400).json({ error: 'Choose one or more exports' });
  }
  runDmList(ctx(req), job, source, sessionIds); // runs in background; client polls GET /jobs/:id
  res.status(202).json({ ok: true });
});

/** Filters for the authentication users report (one row per mapping) and its CSV. */
function filterPairs(pairs, q) {
  const text = String(q.q || '').trim().toLowerCase();
  return pairs.filter(p =>
    (!q.ready || p.ready === q.ready)
    && (!text || [p.sourceEmail, p.destEmail, p.sourceCloud, p.destCloud, p.reason]
      .some(x => String(x || '').toLowerCase().includes(text))));
}

router.get('/jobs/:id/pairs', requireAuth, (req, res) => {
  const job = jobStore.get(req.params.id, req.sessionID);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Results not ready' });
  const rows = filterPairs(job.pairs, req.query);
  const size = [50, 100, 150, 200].includes(Number(req.query.size)) ? Number(req.query.size) : 50;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), pages);
  res.json({ total: job.pairs.length, filtered: rows.length, page, pages, size, rows: rows.slice((page - 1) * size, page * size) });
});

/** Filters used by both the paged table and the CSV download. */
function filterDms(dms, q) {
  const text = String(q.q || '').trim().toLowerCase();
  return dms.filter(d =>
    (!q.type || d.type === q.type)
    && (!q.apiCallHit || d.apiCallHit === q.apiCallHit)
    && (!q.authenticated || d.authenticated === q.authenticated)
    && (!q.allMapped || d.allMapped === q.allMapped)
    && (!text || [d.channelName, d.fromRootId, d.emailPairsRaw, d.whyNot, ...(d.participants || []), ...(d.destParticipants || []), ...(d.notAuthenticatedReason || [])]
      .some(x => String(x || '').toLowerCase().includes(text))));
}

router.get('/jobs/:id/dms', requireAuth, (req, res) => {
  const job = jobStore.get(req.params.id, req.sessionID);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Results not ready' });
  const rows = filterDms(job.dms, req.query);
  const size = [50, 100, 150, 200].includes(Number(req.query.size)) ? Number(req.query.size) : 50;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), pages);
  res.json({ total: job.dms.length, filtered: rows.length, page, pages, size, rows: rows.slice((page - 1) * size, page * size) });
});

const CSV_COLUMNS = {
  dms: [
    { key: 'channelName', label: 'DmName' },
    { key: 'fromRootId', label: 'FromRootId' },
    { key: 'authenticated', label: 'ReadyToInitiate' },
    { key: 'whyNot', label: 'IfNotWhyNot' },
    { key: 'allMapped', label: 'IsMapped' },
    { key: 'authenticatedCount', label: 'UsersProvisioned' },
    { key: 'authenticatedEmails', label: 'AuthenticatedUsers' },
    { key: 'notAuthenticatedReason', label: 'NotAuthenticatedUsersReason' },
    { key: 'type', label: 'Type' },
    { key: 'participants', label: 'SourceParticipants' },
    { key: 'notMappedEmails', label: 'NotMappedParticipants' },
    { key: 'destParticipants', label: 'MappedDestinationUsers' },
    { key: 'emailPairsRaw', label: 'EmailPairs' },
    { key: 'dmId', label: 'DmDocumentId' },
  ],
  // Per side: email, cloud name, cloud status, billing status, auth status (source first, then destination)
  pairs: [
    { key: 'sourceEmail', label: 'SourceEmail' },
    { key: 'sourceCloud', label: 'SourceCloudName' },
    { key: 'sourceCloudStatus', label: 'SourceCloudStatus' },
    { key: 'sourceBillingStatus', label: 'SourceBillingStatus' },
    { key: 'sourceStatus', label: 'SourceAuthStatus' },
    { key: 'destEmail', label: 'DestinationEmail' },
    { key: 'destCloud', label: 'DestinationCloudName' },
    { key: 'destCloudStatus', label: 'DestinationCloudStatus' },
    { key: 'destBillingStatus', label: 'DestinationBillingStatus' },
    { key: 'destStatus', label: 'DestinationAuthStatus' },
    { key: 'ready', label: 'Ready' },
    { key: 'reason', label: 'Reason' },
  ],
};

router.get('/jobs/:id/csv/:kind', requireAuth, (req, res) => {
  const job = jobStore.get(req.params.id, req.sessionID);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Job not finished' });
  const kind = req.params.kind;
  let rows;
  if (kind === 'dms') rows = filterDms(job.dms, req.query);
  else if (kind === 'dms-ready') rows = job.dms.filter(d => d.allReady);
  else if (kind === 'dms-blocked') rows = job.dms.filter(d => !d.allReady);
  else if (kind === 'users') rows = filterPairs(job.pairs, req.query);
  else if (kind === 'users-ready') rows = job.pairs.filter(p => p.ready === 'Yes');
  else return res.status(400).json({ error: 'Unknown CSV type' });
  const cols = CSV_COLUMNS[kind.startsWith('dms') ? 'dms' : 'pairs'];
  const name = `${kind}_${job.params.sourceAdminCloudId}_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(toCsv(rows, cols));
});

module.exports = router;
