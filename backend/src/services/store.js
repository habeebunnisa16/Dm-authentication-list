const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const safe = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const CACHE_VERSION = 7; // bump when validation rules change so old results are ignored
const TTL = () => Number(process.env.CACHE_TTL_MINUTES || 60) * 60000;
// Each Metabase user gets their own files, so nobody reads results their own Metabase permissions
// couldn't produce. The owner is hashed so emails don't appear in file names. '' = shared (API-key mode).
const ownerPrefix = owner => (owner ? `${crypto.createHash('sha256').update(String(owner).toLowerCase()).digest('hex').slice(0, 16)}__` : '');
const cacheFile = (db, src, dst, owner) => path.join(CACHE_DIR, `${ownerPrefix(owner)}${safe(db)}__${safe(src)}__${safe(dst)}.json`);
const fresh = r => r.v === CACHE_VERSION && Date.now() - (r.checkedAt || 0) < TTL();

/** Validation cache per user and combination (the "store it in the cache" step). No tokens are stored. */
const cache = {
  load(db, src, dst, owner) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile(db, src, dst, owner), 'utf8'));
      return Object.fromEntries(Object.entries(data.users || {}).filter(([, r]) => fresh(r)));
    } catch { return {}; }
  },
  save(db, src, dst, usersMap, owner) {
    const file = cacheFile(db, src, dst, owner);
    // Expired entries are dropped on every save, so files don't keep customer data past the TTL
    const existing = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).users || {}; } catch { return {}; } })();
    const users = Object.fromEntries(Object.entries(existing).filter(([, r]) => fresh(r)));
    for (const [email, r] of usersMap) users[email] = { ...r, v: CACHE_VERSION, checkedAt: r.checkedAt || Date.now() };
    // Write then rename, so a crash or a parallel read never sees half a file
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), users }, null, 2));
    fs.renameSync(tmp, file);
  },
  /** Deletes cache files not written within the TTL. Runs at startup and every hour. */
  prune() {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (!/\.(json|tmp)$/.test(name)) continue;
      const file = path.join(CACHE_DIR, name);
      try { if (Date.now() - fs.statSync(file).mtimeMs > TTL()) fs.rmSync(file, { force: true }); } catch { /* gone already */ }
    }
  },
};
cache.prune();
setInterval(() => cache.prune(), 3600000).unref();

/**
 * In-memory job store. Jobs are kept for 6 hours, at most JOBS_PER_SESSION per session and
 * MAX_STORED_JOBS in all (the oldest finished ones are dropped first), so memory stays bounded.
 */
const jobs = new Map();
const JOB_TTL = 6 * 3600000;
const perSession = () => Number(process.env.JOBS_PER_SESSION || 10);
const maxStored = () => Number(process.env.MAX_STORED_JOBS || 200);

/** Drops the oldest finished jobs in `list` until at most `keep` remain. */
function trim(list, keep) {
  const finished = list.filter(j => j.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
  for (let n = list.length - keep; n > 0 && finished.length; n--) jobs.delete(finished.shift().id);
}

const jobStore = {
  create(owner, params) {
    trim([...jobs.values()].filter(j => j.owner === owner), perSession() - 1);
    trim([...jobs.values()], maxStored() - 1);
    const id = crypto.randomUUID();
    const job = {
      id, owner, params, status: 'running', createdAt: Date.now(),
      steps: [], summary: null, users: [], pairs: [], dms: [], error: null,
    };
    jobs.set(id, job);
    return job;
  },
  get(id, owner) {
    const j = jobs.get(id);
    return j && j.owner === owner ? j : null;
  },
  /** Checks of this session that are still running (every session when owner is omitted). */
  running(owner) {
    return [...jobs.values()].filter(j => (owner === undefined || j.owner === owner) && j.status === 'running').length;
  },
  /** Forgets a session's jobs (sign-out or session expiry). Running ones finish in the background, unreachable. */
  removeOwner(owner) {
    for (const [id, j] of jobs) if (j.owner === owner) jobs.delete(id);
  },
};
setInterval(() => {
  for (const [id, j] of jobs) if (Date.now() - j.createdAt > JOB_TTL) jobs.delete(id);
}, 600000).unref();

module.exports = { cache, jobStore };
