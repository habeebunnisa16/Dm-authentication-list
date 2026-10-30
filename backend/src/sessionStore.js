const session = require('express-session');

/**
 * In-memory session store for a shared server. Unlike express-session's MemoryStore it removes
 * expired sessions (so memory doesn't grow with every sign-in), keeps at most `max` sessions
 * (dropping the least recently saved), and calls onRemove(sid, sess) for every session it drops or
 * destroys, so its Metabase session can be closed and its jobs forgotten. A restart signs everyone out.
 */
class PrunedMemoryStore extends session.Store {
  constructor({ max = 2000, onRemove = () => {} } = {}) {
    super();
    this.sessions = new Map(); // sid -> { data: JSON string, expires: ms }
    this.max = max;
    this.onRemove = onRemove;
    setInterval(() => this.prune(), 60000).unref();
  }

  static expiresOf(sess) {
    const e = sess?.cookie?.expires;
    return e ? new Date(e).getTime() : Date.now() + 24 * 3600000;
  }

  remove(sid) {
    const e = this.sessions.get(sid);
    if (!e) return;
    this.sessions.delete(sid);
    try { this.onRemove(sid, JSON.parse(e.data)); } catch (err) { console.error('Session cleanup failed:', err); }
  }

  prune() {
    const now = Date.now();
    for (const [sid, e] of this.sessions) if (e.expires <= now) this.remove(sid);
  }

  get(sid, cb) {
    const e = this.sessions.get(sid);
    if (!e) return cb(null, null);
    if (e.expires <= Date.now()) { this.remove(sid); return cb(null, null); }
    cb(null, JSON.parse(e.data));
  }

  set(sid, sess, cb) {
    this.sessions.delete(sid); // re-insert, so Map order is least recently saved first
    this.sessions.set(sid, { data: JSON.stringify(sess), expires: PrunedMemoryStore.expiresOf(sess) });
    while (this.sessions.size > this.max) this.remove(this.sessions.keys().next().value);
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    const e = this.sessions.get(sid);
    if (e) e.expires = PrunedMemoryStore.expiresOf(sess);
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    this.remove(sid);
    if (cb) cb(null);
  }

  length(cb) { cb(null, this.sessions.size); }

  clear(cb) {
    this.sessions.clear();
    if (cb) cb(null);
  }
}

module.exports = { PrunedMemoryStore };
