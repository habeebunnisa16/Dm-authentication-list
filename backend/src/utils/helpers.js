/** Metabase may return ObjectIds as strings or as {$oid}; normalise to a plain string. */
function idToString(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.$oid || v.oid || v._id || JSON.stringify(v));
  return String(v);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Pulls every email out of whatever shape EmailPairs / EmailIds are stored in. */
function extractEmails(value) {
  if (value == null) return [];
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('[') || t.startsWith('{')) && t.length > 1) {
      try { return extractEmails(JSON.parse(t)); } catch { /* fall through to regex */ }
    }
    return (t.match(EMAIL_RE) || []).map(e => e.toLowerCase());
  }
  if (Array.isArray(value)) return value.flatMap(extractEmails);
  if (typeof value === 'object') return Object.values(value).flatMap(extractEmails);
  return [];
}

const uniq = arr => [...new Set(arr)];

/** Runs async fn over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toCsv(rows, columns) {
  const esc = v => {
    let s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    // Formula injection: a cell starting with = + - @ (or tab / CR) would run as a formula in Excel.
    // Channel names and emails come from customer data, so such cells get a leading apostrophe.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(','));
  return '\uFEFF' + [header, ...body].join('\r\n'); // BOM so Excel opens UTF-8 correctly
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { idToString, chunk, extractEmails, uniq, pool, toCsv, sleep };
