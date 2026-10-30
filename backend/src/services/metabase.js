const config = require('../config');

const BASE = () => (process.env.METABASE_URL || 'https://metabase.cloudfuze.com').replace(/\/+$/, '');
const API_KEY = () => process.env.METABASE_API_KEY || '';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function authHeaders(token) {
  if (API_KEY()) return { 'x-api-key': API_KEY() };
  return token ? { 'X-Metabase-Session': token } : {};
}

const TIMEOUT_MS = () => Number(process.env.METABASE_TIMEOUT_MS || 120000);
const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mbFetch(token, path, opts = {}, attempt = 1) {
  if (!BASE()) throw new HttpError(500, 'METABASE_URL is not set in .env');
  let res;
  try {
    res = await fetch(BASE() + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...authHeaders(token), ...(opts.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new HttpError(504, `Metabase did not answer within ${Math.round(TIMEOUT_MS() / 1000)} s (${path.split('?')[0]})`);
    }
    if (attempt < 3) { await sleep(1000 * attempt); return mbFetch(token, path, opts, attempt + 1); }
    throw new HttpError(502, `Cannot reach Metabase at ${BASE()}: ${e.message}`);
  }
  // Busy or rate limited: wait (Retry-After when given) and try again, up to 3 attempts
  if (RETRYABLE.has(res.status) && attempt < 3) {
    const after = Number(res.headers.get('retry-after'));
    await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * attempt, 30000));
    return mbFetch(token, path, opts, attempt + 1);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : (body.message || body.error || JSON.stringify(body));
    let hint = '';
    if (res.status === 404 && res.redirected) {
      hint = ` (Metabase redirected ${BASE()} to ${res.url.replace(path, '')}; set METABASE_URL to that address in .env)`;
    }
    throw new HttpError(res.status === 401 ? 401 : 502, `Metabase ${res.status}: ${String(detail).slice(0, 300)}${hint}`);
  }
  return body;
}

async function login(username, password) {
  if (API_KEY()) return 'api-key';
  const body = await mbFetch(null, '/api/session', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!body || !body.id) throw new HttpError(401, 'Metabase did not return a session');
  return body.id;
}

async function logout(token) {
  if (API_KEY() || !token) return;
  try { await mbFetch(token, '/api/session', { method: 'DELETE' }); } catch { /* ignore */ }
}

async function currentUser(token) {
  return mbFetch(token, '/api/user/current');
}

async function listDatabases(token) {
  const body = await mbFetch(token, '/api/database');
  const list = Array.isArray(body) ? body : (body.data || []);
  return list.map(d => ({ id: d.id, name: d.name, engine: d.engine }));
}

async function getMetadata(token, dbId) {
  return mbFetch(token, `/api/database/${Number(dbId)}/metadata?include_hidden=true`);
}

/**
 * Helpers for building Mongo pipelines. Use oid("hex") where an ObjectId is needed;
 * it is serialised as ObjectId("hex"), which Metabase's Mongo native queries accept.
 */
const oid = hex => ({ __oid: String(hex) });
const isHex24 = v => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);

function serialize(pipeline) {
  return JSON.stringify(pipeline).replace(/\{"__oid":"([0-9a-fA-F]{24})"\}/g, 'ObjectId("$1")');
}

function assertNoBadOids(pipeline) {
  const s = JSON.stringify(pipeline);
  if (/"__oid":"(?![0-9a-fA-F]{24}")/.test(s)) throw new HttpError(400, 'Invalid ObjectId in query');
}

async function runMongo(token, dbId, collection, pipeline) {
  assertNoBadOids(pipeline);
  const body = {
    database: Number(dbId),
    type: 'native',
    native: { query: serialize(pipeline), collection },
  };
  const r = await mbFetch(token, '/api/dataset', { method: 'POST', body: JSON.stringify(body) });
  if (r.status && r.status !== 'completed') {
    throw new HttpError(502, `Query on ${collection} failed: ${r.error || r.status}`);
  }
  const cols = (r.data?.cols || []).map(c => c.name);
  return (r.data?.rows || []).map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

const idStr = v => (v && typeof v === 'object' ? String(v.$oid || v.oid || JSON.stringify(v)) : String(v));

async function countRows(token, dbId, collection, match) {
  const r = await runMongo(token, dbId, collection, [{ $match: match }, { $count: 'n' }]);
  return Number(r[0]?.n || 0);
}

/** Pages by _id ("give me the next 2000 after the last _id I saw"). Stable and fast. */
async function pageByKey(token, dbId, collection, match, project, size, max) {
  const out = [];
  let last = null;
  for (;;) {
    const m = last == null ? match : { $and: [match, { _id: { $gt: last } }] };
    const pipeline = [{ $match: m }, { $sort: { _id: 1 } }, { $limit: size }];
    if (project) pipeline.push({ $project: project });
    const page = await runMongo(token, dbId, collection, pipeline);
    out.push(...page);
    if (page.length < size || out.length >= max) break;
    const s = idStr(page[page.length - 1]._id);
    last = isHex24(s) ? oid(s) : s;
  }
  return out;
}

/** Pages with $skip. Used as a second attempt if key paging doesn't return every row. */
async function pageBySkip(token, dbId, collection, match, project, size, max) {
  const out = [];
  for (let skip = 0; ; skip += size) {
    const pipeline = [{ $match: match }, { $sort: { _id: 1 } }, { $skip: skip }, { $limit: size }];
    if (project) pipeline.push({ $project: project });
    const page = await runMongo(token, dbId, collection, pipeline);
    out.push(...page);
    if (page.length < size || out.length >= max) break;
  }
  return out;
}

/**
 * Reads every row matching `match`. Metabase returns at most 2000 rows per query, so this
 * pages through the results and then checks the total against a $count, so rows are never
 * silently dropped.
 */
async function findAll(token, dbId, collection, match, project, { max = 500000 } = {}) {
  const size = config.pageSize;
  const expected = await countRows(token, dbId, collection, match);
  if (expected > max) throw new HttpError(413, `${expected} rows in ${collection} is more than the limit of ${max}; narrow the filter`);
  if (expected === 0) return [];
  if (project && !('_id' in project)) project = { ...project, _id: 1 };

  let rows = await pageByKey(token, dbId, collection, match, project, size, max);
  if (rows.length !== expected) {
    console.warn(`${collection}: key paging returned ${rows.length} of ${expected} rows, retrying with skip paging`);
    rows = await pageBySkip(token, dbId, collection, match, project, size, max);
  }
  // Remove any duplicates a shifting page could produce
  const seen = new Set();
  rows = rows.filter(r => { const k = idStr(r._id); if (seen.has(k)) return false; seen.add(k); return true; });
  if (rows.length !== expected) {
    throw new HttpError(502, `${collection}: Metabase returned ${rows.length} of ${expected} matching rows. Try again; if it repeats, the collection may be changing during the read.`);
  }
  return rows;
}

module.exports = { HttpError, getMetadata, login, logout, currentUser, listDatabases, runMongo, findAll, oid, isHex24 };
