const config = require('../config');
const mb = require('./metabase');

/**
 * Metabase shows "friendly" names (e.g. PrimaryEmail for primaryEmail, Users for users).
 * This reads the real collection and field names from Metabase's metadata and maps the
 * names in config.js to them case-insensitively, so capitalisation never breaks a query.
 */
// "<token>|<dbId>" -> { at, tables: Map(normalised name -> [{ name, fields, nested, allFields }, ...]), counts: Map(name -> rows) }
// Keyed per Metabase session, since what metadata a user sees depends on their Metabase permissions.
// A database can hold several collections whose names differ only in case or separators (Users / users);
// all of them are kept, and the one with the most documents is used.
const cache = new Map();
const TTL = 10 * 60 * 1000;
const key = s => String(s).toLowerCase().replace(/[\s_-]/g, '');
const cacheKey = (token, dbId) => `${token}|${dbId}`;
setInterval(() => {
  for (const [k, v] of cache) if (Date.now() - v.at >= TTL) cache.delete(k);
}, TTL).unref();

async function loadSchema(token, dbId) {
  const hit = cache.get(cacheKey(token, dbId));
  if (hit && Date.now() - hit.at < TTL) return hit;
  let meta;
  try {
    meta = await mb.getMetadata(token, dbId);
  } catch (e) {
    await new Promise(r => setTimeout(r, 1000));
    meta = await mb.getMetadata(token, dbId); // one retry; failures are not cached
  }
  const tables = new Map();
  for (const t of meta.tables || []) {
    const fields = new Map();
    const nested = new Map(); // "parent.child" (normalised) -> real dotted path
    const byId = new Map((t.fields || []).map(f => [f.id, f]));
    const pathOf = f => (Array.isArray(f.nfc_path) && f.nfc_path.length ? f.nfc_path
      : f.parent_id && byId.get(f.parent_id) ? [...pathOf(byId.get(f.parent_id)), f.name] : [f.name]);
    for (const f of t.fields || []) {
      const path = pathOf(f);
      if (path.length === 1) fields.set(key(f.name), f.name);
      else nested.set(path.map(key).join('.'), path.join('.'));
    }
    const k = key(t.name);
    tables.set(k, [...(tables.get(k) || []), { name: t.name, fields, nested, allFields: (t.fields || []).filter(f => !f.parent_id).map(f => f.name) }]);
  }
  const entry = { at: Date.now(), tables, counts: new Map(), dbName: meta.name };
  cache.set(cacheKey(token, dbId), entry);
  return entry;
}

/** Resolves a configured field (dot notation allowed for nested fields) to its real name. */
function resolveField(table, alias, fAlias, configured) {
  if (configured.includes('.')) {
    const full = table && table.nested.get(configured.split('.').map(key).join('.'));
    if (full) return { name: full, how: 'name' };
    const [head, ...rest] = configured.split('.');
    const realHead = table && table.fields.get(key(head));
    return { name: [realHead || head, ...rest].join('.'), how: realHead ? 'name' : null };
  }
  const exact = table && table.fields.get(key(configured));
  if (exact) return { name: exact, how: 'name' };
  const guess = table && fallbackField(table, alias, fAlias);
  if (guess) return { name: guess, how: 'pattern' };
  return { name: configured, how: null };
}

function fallbackField(table, alias, fAlias) {
  const patterns = config.fallbacks?.[alias]?.[fAlias] || [];
  for (const p of patterns) {
    const re = new RegExp(p, 'i');
    const hit = table.allFields.find(f => re.test(f));
    if (hit) return hit;
  }
  return null;
}

/**
 * The collection to use for a configured name. With several matches (e.g. Users and users),
 * each is counted once (cached with the schema) and the one with the most documents wins.
 */
async function pickTable(token, dbId, schema, configured) {
  const candidates = schema.tables.get(key(configured)) || [];
  if (candidates.length < 2) return { table: candidates[0] || null, candidates: [] };
  for (const c of candidates) {
    if (schema.counts.has(c.name)) continue;
    const r = await mb.runMongo(token, dbId, c.name, [{ $count: 'n' }]).catch(() => []);
    schema.counts.set(c.name, Number(r[0]?.n || 0));
  }
  const ranked = candidates.map(c => ({ table: c, count: schema.counts.get(c.name) })).sort((a, b) => b.count - a.count);
  return { table: ranked[0].table, candidates: ranked.map(x => ({ name: x.table.name, count: x.count })) };
}

/** Returns { C, F } shaped like config.collections / config.fields but with real names. */
async function resolveNames(token, dbId) {
  let schema;
  try {
    schema = await loadSchema(token, dbId);
  } catch (e) {
    console.warn(`Could not read Metabase metadata for database ${dbId}; using names from config.js as-is. ${e.message}`);
    schema = { tables: new Map(), counts: new Map(), error: e.message };
  }
  const C = {}, F = {}, duplicates = {};
  for (const [alias, configured] of Object.entries(config.collections)) {
    const { table: t, candidates } = await pickTable(token, dbId, schema, configured);
    if (candidates.length) duplicates[alias] = candidates;
    C[alias] = t ? t.name : configured;
    F[alias] = {};
    for (const [fAlias, fConfigured] of Object.entries(config.fields[alias] || {})) {
      F[alias][fAlias] = resolveField(t, alias, fAlias, fConfigured).name;
    }
  }
  return { C, F, schema, duplicates };
}

/** Summary used by /api/schema and in error messages. */
async function describe(token, dbId) {
  const { C, schema, duplicates } = await resolveNames(token, dbId);
  const out = { database: schema.dbName, collections: {} };
  for (const [alias, configured] of Object.entries(config.collections)) {
    const t = (schema.tables.get(key(configured)) || []).find(x => x.name === C[alias]) || null;
    out.collections[alias] = {
      configured,
      found: t ? t.name : null,
      duplicates: duplicates[alias] || [],
      fields: Object.fromEntries(Object.entries(config.fields[alias] || {}).map(([a, fc]) => {
        const r = resolveField(t, alias, a, fc);
        return [a, { configured: fc, found: r.how ? r.name : null, matchedBy: r.how }];
      })),
      allFields: t ? t.allFields : [],
    };
  }
  out.allCollections = [...schema.tables.values()].flat().map(t => t.name).sort();
  if (schema.error) out.metadataError = schema.error;
  return out;
}

function clearCache(token, dbId) { cache.delete(cacheKey(token, dbId)); }

module.exports = { resolveNames, describe, clearCache };
