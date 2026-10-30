(() => {
  const STEPS = ['Connect to Metabase', 'Database', 'Select PrimaryEmail', 'Combination', 'Admin clouds', 'Permission cache', 'Authentication users', 'SlackDms list'];
  const state = {
    step: 0, user: null, apiKeyMode: false, metabaseUrl: '',
    databases: [], db: null, cloudTypes: [], authRules: {}, authRulesAll: {}, codeVersion: 'old',
    sourceType: 'SLACK', destType: '',
    adminEmail: '', adminUser: null, clouds: [], src: null, dst: null,
    perm: null, jobId: null, job: null, jobDone: false, dmListOn: false, pollTimer: null,
    userList: { dbId: null, q: '', users: [], total: 0, loading: false, seq: 0 }, cloudSeq: 0, autoPicked: { src: false, dst: false },
    pairFilters: { q: '', ready: '', page: 1, size: 50 }, tab: 'users', jobKey: '',
    dmFilters: { q: '', type: '', apiCallHit: '', authenticated: '', allMapped: '', page: 1, size: 50 },
  };

  const $ = s => document.querySelector(s);
  const view = $('#view');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const typeLabel = v => state.cloudTypes.find(t => t.value === v)?.label || v || '';

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/auth/login') { state.user = null; go(0); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 12000 : 5000);
  }

  function busy(btn, text) {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = text;
    return () => { btn.disabled = false; btn.textContent = old; };
  }

  /** A step can be opened once everything it needs has been chosen. */
  function canOpen(i) {
    switch (i) {
      case 0: return !state.user;
      case 1: return !!state.user;
      case 2: return !!(state.user && state.db);
      case 3: return !!(state.user && state.db && state.adminUser);
      case 4: return !!(state.user && state.db && state.adminUser && state.destType);
      case 5: return !!(state.user && state.db && state.src && state.dst && state.adminUser);
      case 6: return !!(state.user && state.jobId);
      case 7: return !!(state.user && state.jobId && state.jobDone && state.dmListOn);
      default: return false;
    }
  }

  function renderRail() {
    $('#steps').innerHTML = STEPS.map((s, i) => {
      // The DM list step stays hidden until a DM list report is asked for
      if (i === 7 && state.step !== 7 && !canOpen(7)) return '';
      const cls = i === state.step ? 'current' : (canOpen(i) || (i === 0 && state.user)) ? 'done' : '';
      return `<li class="${cls}"><button type="button" data-step="${i}" ${i === state.step ? 'aria-current="step"' : ''}
        ${canOpen(i) && i !== state.step ? '' : 'disabled'}>${esc(i === 7 ? dmListName(state.job?.summary?.dmSource === 'delta' ? 'json' : state.job?.summary?.dmSource || state.job?.params?.mode) : s)}</button></li>`;
    }).join('');
    $('#steps').querySelectorAll('button[data-step]').forEach(b => b.onclick = () => {
      const i = Number(b.dataset.step);
      if (i === 1 && !state.databases.length) return loadDatabases().then(() => go(1)).catch(e => toast(e.message, true));
      go(i);
    });
    $('#who').hidden = !state.user;
    $('#whoName').textContent = state.user ? `Signed in as ${state.user.email}` : '';
    const cs = $('#codeSwitch');
    if (cs) {
      cs.innerHTML = ['old', 'new'].map(v => `<button type="button" data-code="${v}" aria-pressed="${state.codeVersion === v}">${v === 'new' ? 'New code' : 'Old code'}</button>`).join('');
      cs.querySelectorAll('[data-code]').forEach(b => b.onclick = () => { if (b.dataset.code !== state.codeVersion) switchVersion(b.dataset.code); });
    }
    // Signed out: the home page uses the full width, without the step menu
    document.body.classList.toggle('home-mode', !state.user);
  }

  function go(step) {
    if (state.pollTimer && step !== 6 && step !== 7) { clearInterval(state.pollTimer); state.pollTimer = null; }
    state.step = step;
    renderRail();
    [viewConnect, viewDatabases, viewUser, viewCombination, viewAdmin, viewPermission, viewAuthUsers, viewDmsList][step]();
    view.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  /** The header every screen starts with: a title, one short line under it, and optional buttons on the right. */
  const pageHead = (title, sub, actions = '') => `
    <header class="page-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${actions}</header>`;

  // ---------- 1. Home: about + connect to Metabase ----------
  function viewConnect() {
    const flow = ['Database', 'PrimaryEmail', 'Combination', 'Admin clouds', 'Mapping', 'Authentication users', 'SlackDms list'];
    view.innerHTML = `
      <div class="home">
        <section class="hero">
          <div class="home-brand"><img src="/cloudfuze-logo.png" alt="CloudFuze"></div>
          <p class="eyebrow">Migration readiness</p>
          <h1>DM authentication check</h1>
          <p class="lead">See which mapped users are authenticated and which DMs are ready to migrate,
            for Slack, Microsoft Teams and Google Chat.</p>
          <div class="connect">
            <div class="version-pick" role="radiogroup" aria-label="Migration code">
              ${versionChoice('old', 'Old code', 'Teams to Teams: destination users must be provisioned (ProvisionStatus).')}
              ${versionChoice('new', 'New code', 'Teams needs no authentication, only mapping. Slack is still checked.')}
            </div>
            <button class="btn btn-lg" id="connectBtn" type="button">Connect to Metabase</button>
            <form id="loginForm" class="login" hidden>
              ${state.appPassword ? '' : '<div class="field"><label for="u">Metabase email</label><input id="u" type="email" autocomplete="username" required maxlength="320"></div>'}
              <div class="field"><label for="p">${state.appPassword ? 'App password' : 'Password'}</label><input id="p" type="password" autocomplete="current-password" required maxlength="1000"></div>
              <button class="btn btn-lg" type="submit" id="loginBtn">Sign in</button>
            </form>
            <p class="muted">Signs in to ${esc(state.metabaseUrl || 'Metabase')}. Read-only; your password isn't stored.</p>
          </div>
        </section>

        <section class="about" aria-labelledby="aboutTitle">
          <h2 id="aboutTitle">About</h2>
          <div class="about-grid">
            <div>
              <h3>What it checks</h3>
              <p>For a source → destination pair of admin clouds, it lists every mapped user with their authentication status,
                then every DM of those users and whether it's ready to initiate, with the reason when it isn't.</p>
            </div>
            <div>
              <h3>How users are checked</h3>
              <p>Slack users are checked live with Slack <code>auth.test</code> on their stored token, so a revoked token fails.
                With old code, a Teams destination (Teams to Teams) uses ProvisionStatus; with new code, Teams needs only mapping.
                Google Chat needs no check.</p>
            </div>
            <div>
              <h3>Where the data comes from</h3>
              <p>Users, Clouds, PermissionCache, ProvisionStatus, CFOAuthCredentials and SlackDms, read through Metabase.
                Nothing is written back. Mapping can also come from an uploaded CSV.</p>
            </div>
          </div>

          <div class="about-grid two">
            <div>
              <h3>Which side needs authentication <span class="hint" id="homeRulesFor"></span></h3>
              <div id="homeRules"><p class="muted">Loading…</p></div>
            </div>
            <div>
              <h3>How it works</h3>
              <ol class="flow">${flow.map(f => `<li>${f}</li>`).join('')}</ol>
            </div>
          </div>
        </section>
      </div>`;
    // The rules table comes from the server (services/rules.js); /cloud-types needs no sign-in
    const showRules = () => {
      const el = $('#homeRules');
      if (el && state.cloudTypes.length) el.innerHTML = rulesTable();
      if ($('#homeRulesFor')) $('#homeRulesFor').textContent = state.codeVersion === 'new' ? '(new code)' : '(old code)';
    };
    (state.cloudTypes.length ? Promise.resolve() : api('/cloud-types').then(t => {
      state.cloudTypes = t.cloudTypes; state.dmTypes = t.dmTypes || {}; setRules(t);
    })).then(showRules).catch(() => {});
    view.querySelectorAll('[data-version]').forEach(b => b.onclick = () => {
      state.codeVersion = b.dataset.version;
      setRules();
      view.querySelectorAll('[data-version]').forEach(x => { x.setAttribute('aria-checked', String(x === b)); x.setAttribute('aria-pressed', String(x === b)); });
      showRules();
    });
    const first = () => $('#u') || $('#p');
    $('#connectBtn').onclick = async () => {
      // API-key mode signs in with the server's key; with APP_PASSWORD set it asks for that password first
      if (state.apiKeyMode && !state.appPassword) return doLogin('', '');
      $('#loginForm').hidden = false; $('#connectBtn').hidden = true; first().focus();
    };
    $('#loginForm').onsubmit = e => { e.preventDefault(); doLogin($('#u')?.value || '', $('#p').value); };
    // After a sign-out, go straight to an empty form so another account can sign in
    if (state.switchAccount && (!state.apiKeyMode || state.appPassword)) {
      state.switchAccount = false;
      $('#loginForm').hidden = false; $('#connectBtn').hidden = true;
      if ($('#u')) $('#u').value = '';
      $('#p').value = ''; first().focus();
    }
  }

  async function doLogin(username, password) {
    const btn = $('#loginBtn') || $('#connectBtn');
    const done = busy(btn, 'Signing in…');
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username, password, codeVersion: state.codeVersion } });
      state.user = r.user;
      state.codeVersion = r.codeVersion || state.codeVersion;
      await loadDatabases();
      go(1);
    } catch (e) { toast(e.message, true); done(); }
  }

  /** Old code / new code option on the Connect page. */
  const versionChoice = (v, title, desc) => `
    <button class="choice version" type="button" role="radio" data-version="${v}" aria-checked="${state.codeVersion === v}" aria-pressed="${state.codeVersion === v}">
      <span class="tick" aria-hidden="true"></span>
      <span><strong>${title}</strong><br><span class="muted">${desc}</span></span>
      <span></span>
    </button>`;

  /** Keeps the rules for the chosen code version in state.authRules (from /cloud-types). */
  function setRules(types) {
    if (types) state.authRulesAll = types.authRulesByVersion || { old: types.authRules || {}, new: types.authRules || {} };
    state.authRules = state.authRulesAll?.[state.codeVersion] || state.authRulesAll?.old || {};
  }

  /** Switches old / new code after sign-in. Results from the other version no longer apply. */
  async function switchVersion(v) {
    try {
      await api('/settings/code-version', { method: 'POST', body: { codeVersion: v } });
      state.codeVersion = v;
      setRules();
      Object.assign(state, { jobId: null, job: null, jobDone: false, dmListOn: false, jobKey: '' });
      toast(`Switched to ${v === 'new' ? 'new' : 'old'} code. Run the reports again to apply it.`);
      go(state.step >= 5 ? 5 : state.step);
    } catch (e) { toast(e.message, true); }
  }

  async function loadDatabases() {
    const [dbs, types] = await Promise.all([api('/databases'), api('/cloud-types')]);
    state.databases = dbs.databases; state.cloudTypes = types.cloudTypes;
    state.dmTypes = types.dmTypes || {}; setRules(types);
  }

  /** Which sides need authentication for a combination, as plain words. */
  function ruleText(src, dst) {
    const r = state.authRules?.[src]?.[dst];
    if (!r) return '';
    const side = (role, type) => `${role} (${typeLabel(type)})`;
    if (r.source && r.destination) return `Authentication is checked on both sides: ${side('source', src)} and ${side('destination', dst)}.`;
    if (r.source) return `Authentication is checked on the ${side('source', src)} side only.`;
    if (r.destination) return `Authentication is checked on the ${side('destination', dst)} side only.`;
    return 'No authentication is needed for this combination; users and DMs only need to be mapped.';
  }

  /** The authentication rules for every combination, as a table (shown on the Combination screen). */
  function rulesTable() {
    const types = state.cloudTypes.map(t => t.value);
    const typeLabel = v => (state.cloudTypes.find(t => t.value === v)?.label || v).replace(/^(Microsoft|Google) /, '');
    const cell = (s, d) => {
      const r = state.authRules?.[s]?.[d];
      const txt = !r ? '' : r.source && r.destination ? 'Both' : r.source ? 'Source' : r.destination ? 'Destination' : 'None';
      return `<td><span class="tag ${txt === 'None' ? 'tag-na' : 'tag-ok'}">${txt}</span></td>`;
    };
    return `<div class="table-wrap rules"><table>
        <thead><tr><th>Source ↓ / Destination →</th>${types.map(d => `<th>${esc(typeLabel(d))}</th>`).join('')}</tr></thead>
        <tbody>${types.map(s => `<tr><th>${esc(typeLabel(s))}</th>${types.map(d => cell(s, d)).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
  }

  // ---------- 2. Databases ----------
  function viewDatabases() {
    const list = [...state.databases].sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) {
      view.innerHTML = `${pageHead('Choose a database')}
        <section class="card narrow"><p class="empty">Your Metabase account can't see any databases. Ask a Metabase admin to grant access, then sign in again.</p></section>`;
      return;
    }
    view.innerHTML = `
      ${pageHead('Choose a database', 'The project database that holds the migration.')}
      <section class="card narrow">
        <div class="field">
          <label for="dbSearch">Search projects</label>
          <input id="dbSearch" type="search" placeholder="Type to filter, e.g. gobaker" autocomplete="off">
        </div>
        <div class="field">
          <label for="dbSelect">Project database</label>
          <select id="dbSelect"></select>
          <span class="muted" id="dbCount"></span>
        </div>
        <div class="actions"><button class="btn" id="dbNext" type="button">Continue</button></div>
      </section>`;
    const sel = $('#dbSelect'), search = $('#dbSearch');
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      const shown = list.filter(d => d.name.toLowerCase().includes(q));
      sel.innerHTML = shown.length
        ? shown.map(d => `<option value="${esc(d.id)}" ${state.db?.id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')
        : '<option value="">No projects match</option>';
      $('#dbCount').textContent = `${shown.length} of ${list.length} projects`;
      $('#dbNext').disabled = !shown.length;
    };
    search.oninput = fill;
    search.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#dbNext').click(); } };
    fill();
    search.focus();
    $('#dbNext').onclick = () => {
      const d = list.find(x => String(x.id) === sel.value);
      if (!d) return toast('Choose a project database', true);
      if (state.db?.id !== d.id) Object.assign(state, { adminUser: null, clouds: [], src: null, dst: null, perm: null, upload: null });
      state.db = d;
      go(2);
    };
  }

  // ---------- 3. Combination ----------
  function viewCombination() {
    const opts = sel => state.cloudTypes.map(t => `<option value="${esc(t.value)}" ${t.value === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
    view.innerHTML = `
      ${pageHead('Choose the combination', esc(state.db.name))}
      <section class="card narrow">
        <form id="comboForm">
          <div class="row">
            <div class="field"><label for="srcType">Source</label><select id="srcType">${opts(state.sourceType)}</select></div>
            <span class="arrow" aria-hidden="true">→</span>
            <div class="field"><label for="dstType">Destination</label><select id="dstType"><option value="">Choose…</option>${opts(state.destType)}</select></div>
          </div>
          <p class="pill" id="comboHint"></p>
          <div class="actions">
            <button class="btn" type="submit">Continue</button>
            <button class="btn-quiet btn" type="button" id="back">Change database</button>
          </div>
        </form>
        <details class="more"><summary>Which side needs authentication</summary>
          <p class="muted">Slack sides are checked live with Slack auth.test; a Teams destination (Teams to Teams) uses ProvisionStatus.</p>
          ${rulesTable()}
        </details>
      </section>`;
    const hint = () => {
      const d = $('#dstType').value;
      $('#comboHint').textContent = d ? ruleText($('#srcType').value, d) : 'Choose a destination to see which side needs authentication.';
    };
    $('#srcType').onchange = hint; $('#dstType').onchange = hint; hint();
    $('#back').onclick = () => go(2);
    $('#comboForm').onsubmit = e => {
      e.preventDefault();
      const s = $('#srcType').value, d = $('#dstType').value;
      if (!d) return toast('Choose a destination', true);
      // Same type is allowed (Slack to Slack, Chat to Chat, Teams to Teams); the clouds must differ
      const changed = s !== state.sourceType || d !== state.destType;
      state.sourceType = s; state.destType = d;
      // Auto mode: re-pick the clouds for the new combination
      if (changed) { state.src = state.dst = null; state.perm = null; if (state.adminUser) autoPickClouds(); }
      go(4);
    };
  }

  // ---------- 4. Admin clouds ----------
  const sameType = () => state.sourceType === state.destType;

  /** Admin clouds that fit each side, falling back to every admin cloud when the names don't match the chosen types. */
  function adminLists() {
    const match = t => state.clouds.filter(c => String(c.cloudName).toUpperCase().replace(/[\s-]/g, '_').includes(t));
    let srcList = match(state.sourceType), dstList = match(state.destType);
    const fallback = !!state.clouds.length && (!srcList.length || !dstList.length);
    if (fallback) { srcList = srcList.length ? srcList : state.clouds; dstList = dstList.length ? dstList : state.clouds; }
    return { srcList, dstList, fallback };
  }

  const isActive = c => /^(active|connected)$/i.test(String(c.cloudStatus || '').trim());

  /**
   * Auto mode: picks the source and destination admin clouds from the chosen combination.
   * A side is picked when it has exactly one cloud of that type, or exactly one active one.
   * Same-type combinations are left to the user, since the direction can't be inferred.
   */
  function autoPickClouds() {
    const { srcList, dstList, fallback } = adminLists();
    state.autoPicked = { src: false, dst: false };
    if (fallback || sameType()) return;
    const pick = list => (list.length === 1 ? list[0] : list.filter(isActive).length === 1 ? list.find(isActive) : null);
    const s = pick(srcList), d = pick(dstList);
    if (s) { state.src = s; state.autoPicked.src = true; }
    if (d && d.cloudId !== s?.cloudId) { state.dst = d; state.autoPicked.dst = true; }
  }

  /** Source or destination admin clouds as option buttons; the chosen one shows a green tick. */
  function cloudButtons(role, list) {
    const selected = state[role];
    const other = state[role === 'src' ? 'dst' : 'src'];
    if (!list.length) return '<p class="empty">No admin clouds of this type for this user.</p>';
    // Same-type combinations (Teams to Teams etc.) list the same clouds on both sides.
    // Picking the cloud chosen on the other side swaps the two, so either direction can be set.
    return `<div class="choices">${list.map(c => {
      const taken = other?.cloudId === c.cloudId;
      const takenLabel = `Chosen as ${role === 'src' ? 'destination' : 'source'}`;
      return `
      <button class="choice" type="button" data-role="${role}" data-id="${esc(c.cloudId)}" aria-pressed="${selected?.cloudId === c.cloudId}" ${taken && !sameType() ? 'disabled' : ''}>
        <span class="tick" aria-hidden="true"></span>
        <span><span class="email">${esc(c.email || c.cloudName)}</span><br><code>${esc(c.cloudId)}</code></span>
        <span class="meta">${taken ? (sameType() ? `${takenLabel}<br>click to swap` : takenLabel) : `${esc(c.cloudName)}<br>${esc(c.cloudStatus)}`}</span>
      </button>`;
    }).join('')}</div>`;
  }

  // ---------- 3. Select PrimaryEmail (from the Users collection) ----------
  // Every Users document (_id + PrimaryEmailId), loaded once per database and searched here
  const freshUserList = () => ({ dbId: null, q: '', users: [], total: 0, withoutEmail: 0, source: '', duplicates: [], loading: false, seq: 0 });
  const MAX_USER_OPTIONS = 200; // option buttons drawn at once; the search covers the rest

  async function loadUsers() {
    const ul = state.userList;
    const seq = ++ul.seq;
    ul.loading = true; renderUserOptions();
    try {
      const r = await api(`/users?${new URLSearchParams({ dbId: state.db.id })}`);
      if (seq !== ul.seq) return; // the database changed meanwhile
      Object.assign(ul, {
        dbId: state.db.id, users: r.users, total: r.total, withoutEmail: r.withoutEmail,
        source: `${r.collection}.${r.field}`, duplicates: r.duplicates || [],
      });
    } catch (e) {
      if (seq === ul.seq) toast(e.message, true);
    }
    if (seq === ul.seq) { ul.loading = false; renderUserOptions(); }
  }

  function renderUserOptions() {
    const list = $('#userList'), count = $('#userCount'), dup = $('#userDup');
    if (!list) return;
    const ul = state.userList;
    const q = ul.q.toLowerCase();
    const hits = q ? ul.users.filter(u => u.email.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)) : ul.users;
    const shown = hits.slice(0, MAX_USER_OPTIONS);
    list.innerHTML = ul.loading ? '<p class="empty">Loading users…</p>'
      : shown.map(u => `
        <button class="choice user-choice" type="button" data-user="${esc(u.id)}" aria-pressed="${state.adminUser?.id === u.id}">
          <span class="tick" aria-hidden="true"></span>
          <span class="email">${u.email ? esc(u.email) : `<span class="muted">(no PrimaryEmailId)</span> ${esc(u.id)}`}</span>
          <code>${esc(u.id)}</code>
        </button>`).join('') || `<p class="empty">${ul.q ? `No user matches "${esc(ul.q)}".` : 'No documents in the Users collection.'}</p>`;
    const noEmail = ul.withoutEmail ? ` · ${ul.withoutEmail} without a PrimaryEmailId` : '';
    count.textContent = ul.loading ? '' : `${ul.total} users from ${ul.source}${noEmail}`
      + (hits.length > shown.length ? ` · showing ${shown.length} of ${hits.length} matches, type to narrow` : q ? ` · ${hits.length} match` : '');
    dup.hidden = !ul.duplicates.length;
    dup.innerHTML = ul.duplicates.length
      ? `This database has ${ul.duplicates.length} Users collections: ${ul.duplicates.map(d => `<b>${esc(d.name)}</b> (${d.count} documents)`).join(', ')}. Using <b>${esc(ul.duplicates[0].name)}</b>, the one with the most users.`
      : '';
    list.querySelectorAll('[data-user]').forEach(b => b.onclick = () => pickUser(b.dataset.user));
  }

  async function pickUser(id) {
    if (!id || state.adminUser?.id === id) return;
    const seq = ++state.cloudSeq;
    // Show the tick straight away; the user's admin clouds load behind it
    $('#userList')?.querySelectorAll('[data-user]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.user === id)));
    if ($('#userNext')) { $('#userNext').disabled = true; $('#userNext').textContent = 'Loading…'; }
    try {
      const r = await api('/admin-clouds', { method: 'POST', body: { dbId: state.db.id, userId: id } });
      if (seq !== state.cloudSeq) return; // another user was picked meanwhile
      Object.assign(state, { adminUser: r.user, adminEmail: r.user.email, clouds: r.clouds, src: null, dst: null, perm: null });
      if (state.destType) autoPickClouds();
    } catch (e) {
      if (seq === state.cloudSeq) toast(e.message, true);
    }
    if (seq === state.cloudSeq && $('#userNext')) {
      $('#userNext').disabled = !state.adminUser;
      $('#userNext').textContent = state.adminUser
        ? `Continue with ${state.adminUser.email}` : 'Continue';
    }
  }

  function viewUser() {
    if (state.userList.dbId !== state.db.id) state.userList = { ...freshUserList(), seq: state.userList.seq };
    view.innerHTML = `
      ${pageHead('Select PrimaryEmail', `From the Users collection of ${esc(state.db.name)}.`,
        '<button class="btn btn-quiet" id="back" type="button">← Database</button>')}
      <section class="card">
        <p class="notice" id="userDup" hidden></p>
        <div class="field">
          <label for="userSearch">Search PrimaryEmail</label>
          <input id="userSearch" type="search" value="${esc(state.userList.q)}" placeholder="Part of a PrimaryEmailId or _id" autocomplete="off">
          <span class="muted" id="userCount"></span>
        </div>
        <div class="choices user-list" id="userList" role="listbox" aria-label="Users"></div>
        <div class="actions">
          <button class="btn" id="userNext" type="button" ${state.adminUser ? '' : 'disabled'}>${state.adminUser
            ? `Continue with ${esc(state.adminUser.email)}` : 'Continue'}</button>
        </div>
      </section>`;
    $('#back').onclick = () => go(1);
    let t;
    $('#userSearch').oninput = e => {
      clearTimeout(t);
      t = setTimeout(() => { state.userList.q = e.target.value.trim(); renderUserOptions(); }, 150);
    };
    $('#userNext').onclick = () => go(3);
    renderUserOptions();
    if (state.userList.dbId !== state.db.id) loadUsers();
    $('#userSearch').focus();
  }

  // ---------- 5. Admin clouds (source and destination) ----------
  function viewAdmin() {
    if (!state.src && !state.dst) autoPickClouds();
    view.innerHTML = `
      ${pageHead('Admin clouds', `${esc(typeLabel(state.sourceType))} → ${esc(typeLabel(state.destType))} · ${esc(state.db.name)}`,
        '<button class="btn btn-quiet" id="changeUser" type="button">Change PrimaryEmail</button>')}
      <section class="card">
        <div id="cloudArea"></div>
      </section>
      <div class="actions" id="adminActions"></div>`;
    $('#changeUser').onclick = () => go(2);
    renderClouds();
  }

  function renderClouds() {
    const area = $('#cloudArea'), actions = $('#adminActions');
    if (!area) return;
    const { srcList, dstList, fallback } = adminLists();
    const auto = side => (state.autoPicked?.[side] && state[side] ? ' <span class="tag tag-ok">auto</span>' : '');
    const heading = (side, type, list, key) => `${side} · ${esc(typeLabel(type))}${auto(key)}${(list.length > 1 || sameType()) && !state[key] ? ' <span class="hint">choose one</span>' : ''}`;

    area.innerHTML = state.adminUser ? `
      <p class="muted">${esc(state.adminUser.email)}</p>
      ${state.clouds.length ? '' : '<p class="empty">This user has no admin clouds (Clouds with isAdmin = true).</p>'}
      ${fallback ? '<p class="notice">Some clouds didn\'t match the chosen types by name, so all admin clouds are shown.</p>' : ''}
      ${state.clouds.length && sameType() ? `<p class="notice">Both sides are ${esc(typeLabel(state.sourceType))}: choose which cloud is which.</p>` : ''}
      <h3>${heading('Source', state.sourceType, srcList, 'src')}</h3>${cloudButtons('src', srcList)}
      <h3>${heading('Destination', state.destType, dstList, 'dst')}</h3>${cloudButtons('dst', dstList)}`
      : '<p class="empty">Pick a user to see their admin clouds.</p>';

    actions.innerHTML = `
      <button class="btn" type="button" id="toPerm" ${state.src && state.dst ? '' : 'disabled'}>Continue to permission cache</button>
      ${sameType() && state.adminUser ? `<button class="btn btn-quiet" type="button" id="swapDir" ${state.src || state.dst ? '' : 'disabled'}>⇄ Swap direction</button>` : ''}
      <button class="btn btn-quiet" type="button" id="back">Change combination</button>`;

    $('#back').onclick = () => go(3);
    area.querySelectorAll('.choice[data-role]').forEach(b => b.onclick = () => {
      const role = b.dataset.role, other = role === 'src' ? 'dst' : 'src';
      const c = state.clouds.find(x => x.cloudId === b.dataset.id);
      if (state[other]?.cloudId === c.cloudId) {
        if (!sameType()) return toast('Source and destination must be different clouds', true);
        state[other] = state[role] || null; // swap sides
        state.autoPicked[other] = false;
      }
      state[role] = c;
      state.autoPicked[role] = false;
      state.perm = null;
      renderClouds();
    });
    const swap = $('#swapDir');
    if (swap) swap.onclick = () => { [state.src, state.dst] = [state.dst, state.src]; state.perm = null; renderClouds(); };
    $('#toPerm').onclick = () => { state.perm = null; go(5); };
  }

  // ---------- 5. Permission cache (or an uploaded mapping CSV) ----------

  /** Splits CSV text into rows of cells. Handles quotes, BOM, CRLF, and , ; or tab as the delimiter. */
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') cell += c;
        else if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim()));
  }

  const EMAIL_ONE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** Source → destination rows from an uploaded CSV. Columns are found by header, or are the first two. */
  function mappingFromCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('The file is empty');
    const head = rows[0].map(h => h.trim().toLowerCase().replace(/[\s_-]/g, ''));
    let si = head.findIndex(h => /^(source|src)(email|emailid|mail|user)?$/.test(h));
    let di = head.findIndex(h => /^(dest|destination|dst|target)(email|emailid|mail|user)?$/.test(h));
    let body = rows.slice(1);
    if (si < 0 || di < 0) {
      if (!EMAIL_ONE.test(String(rows[0][0] || '').trim())) {
        throw new Error('Could not find the SourceEmail and DestEmail columns. Use a header row like: SourceEmail,DestEmail');
      }
      si = 0; di = 1; body = rows; // no header: first column source, second destination
    }
    const out = [], seen = new Set();
    let skipped = 0;
    for (const r of body) {
      const sourceEmail = String(r[si] || '').trim().toLowerCase();
      const destEmail = String(r[di] || '').trim().toLowerCase();
      if (!EMAIL_ONE.test(sourceEmail) || (destEmail && !EMAIL_ONE.test(destEmail))) { skipped++; continue; }
      const k = `${sourceEmail}|${destEmail}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ sourceEmail, destEmail });
    }
    if (!out.length) throw new Error('No rows with a valid SourceEmail were found');
    return { rows: out, skipped };
  }

  // Export-JSON report types: what each does, shown under the dropdown and on hover
  const EXPORT_TIPS = {
    onetime: 'OneTime-Migration-List: the DMs of the selected exports from ExportChannelInfo (sessionId, dm = true), matched to the users already checked.',
    delta: 'Delta-validation: the already initiated DMs of the selected exports from MessageWorkSpace; EmailPairs (destination emails) matched to the users already checked through the mapping.',
  };
  const EXPORT_LABELS = { onetime: 'OneTime-Migration-List', delta: 'Delta-validation' };

  /**
   * Tags for the Reports card, built from the combination, the code version and the report type:
   * what is checked on which side (Slack token, ProvisionStatus) or that no check is needed.
   */
  function checkTags() {
    const s = state.sourceType, d = state.destType;
    const delta = state.reportView === 'dms' && state.dmSource === 'delta';
    const rule = delta
      ? { source: true, destination: state.codeVersion === 'old' && d === 'MICROSOFT_TEAMS' } // Delta-validation's own rule
      : state.authRules?.[s]?.[d] || {};
    const how = t => (t === 'SLACK' ? 'Slack token' : 'ProvisionStatus');
    const checks = [
      rule.source && `Checked: Source ${typeLabel(s)} (${how(s)})`,
      rule.destination && `Checked: Destination ${typeLabel(d)} (${how(d)})`,
    ].filter(Boolean);
    return [`${typeLabel(s)} → ${typeLabel(d)}`, `${state.codeVersion === 'new' ? 'New' : 'Old'} code`,
      ...(checks.length ? checks : ['No authentication needed, mapping only'])]
      .map(t => `<span class="pill">${esc(t)}</span>`).join('');
  }
  /** The DM list's name for a report mode: api (SlackDms), onetime (ExportChannelInfo), json (Delta-validation). */
  const dmListName = mode => (mode === 'onetime' ? 'ExportChannelInfo-Dms-List' : mode === 'json' ? 'Delta-Initiate-List' : 'SlackDms list');
  const modeLabel = mode => (mode === 'onetime' ? EXPORT_LABELS.onetime : mode === 'json' ? EXPORT_LABELS.delta : '');

  async function viewPermission() {
    view.innerHTML = `${pageHead('Permission cache', 'Loading the mapping…')}`;
    try {
      if (!state.perm) {
        state.perm = await api('/permission-cache', {
          method: 'POST',
          body: { dbId: state.db.id, sourceAdminCloudId: state.src.cloudId, destAdminCloudId: state.dst.cloudId },
        });
      }
    } catch (e) {
      // PermissionCache can fail to load while an uploaded CSV still works
      state.perm = { rows: [], warning: e.message };
    }
    const up = state.upload;
    const rows = up ? up.rows : state.perm.rows;
    const source = up ? 'the uploaded CSV' : 'PermissionCache';
    const rule = state.authRules?.[state.sourceType]?.[state.destType] || {};
    const slackSide = (rule.source && state.sourceType === 'SLACK') || (rule.destination && state.destType === 'SLACK');
    const how = [];
    if (rule.source || rule.destination) {
      if (slackSide) how.push('Slack sides are checked live with auth.test, so a user counts only if their Slack token is still valid (a password change revokes it).');
      if ((rule.source && state.sourceType !== 'SLACK') || (rule.destination && state.destType !== 'SLACK')) {
        how.push('The Teams destination is checked in ProvisionStatus (Provisioned = true).');
      }
    } else {
      how.push('Every mapped user is listed as "Not required".');
    }
    how.push(`For the SlackDms, the source users come from ${source} and their DM entries are read from SlackDms for the source admin cloud. `
      + 'When only the destination needs authentication, each participant\'s mapped destination user is checked.');

    // Two options: Auth users list (DM lists built later from it), or Auth users DM list in one go
    const slackSource = state.sourceType === 'SLACK';
    if (!slackSource && state.dmSource && state.dmSource !== 'api') state.dmSource = 'api'; // Export-JSON is Slack source only
    const dmSource = state.dmSource || 'api';
    const reportChoice = (v, title, desc) => `
      <button class="choice version" type="button" role="radio" data-report="${v}" aria-checked="${(state.reportView || 'users') === v}" aria-pressed="${(state.reportView || 'users') === v}">
        <span class="tick" aria-hidden="true"></span>
        <span><strong>${title}</strong><br><span class="muted">${desc}</span></span>
      </button>`;

    const table = `<div class="table-wrap table-scroll clean short"><table>
          <thead><tr><th>Source email · ${esc(typeLabel(state.sourceType))}</th><th>Destination email · ${esc(typeLabel(state.destType))}</th></tr></thead>
          <tbody>${rows.slice(0, 500).map(r => `<tr><td class="email">${esc(r.sourceEmail)}</td><td class="email">${esc(r.destEmail) || '<span class="muted">none</span>'}</td></tr>`).join('')}</tbody>
        </table></div>`;

    view.innerHTML = `
      ${pageHead('Permission cache', `${esc(typeLabel(state.sourceType))} → ${esc(typeLabel(state.destType))} · ${esc(state.db.name)}`,
        '<button class="btn btn-quiet" id="back" type="button">← Admin clouds</button>')}

      <section class="card" id="reportsCard">
        <div class="toolbar">
          <div>
            <h2 class="card-title">Reports</h2>
            <div class="pills">${checkTags()}</div>
          </div>
        </div>
        <div class="report-pick" role="radiogroup" aria-label="Report">
          ${reportChoice('users', 'Auth users list', 'Check the users once; build their DM lists afterwards on the next page.')}
          ${reportChoice('dms', 'Auth users DM list', 'Choose where the DMs come from, then check the users and open that DM list in one go.')}
        </div>
        ${state.reportView === 'dms' ? `
          <div class="report-type">
            <label class="filter"><span>Fetch DMs from</span>
              <select id="pDmFetch">
                <option value="api" ${dmSource === 'api' ? 'selected' : ''}>API: SlackDms</option>
                <option value="export" ${dmSource !== 'api' ? 'selected' : ''} ${slackSource ? '' : 'disabled'}>Export-JSON${slackSource ? '' : ' (Slack source only)'}</option>
              </select>
            </label>
            ${dmSource !== 'api' ? `
            <label class="filter"><span>Export-JSON type</span>
              <select id="pExportKind">
                <option value="onetime" ${dmSource === 'onetime' ? 'selected' : ''}>OneTime-Migration-List: ExportChannelInfo</option>
                <option value="delta" ${dmSource === 'delta' ? 'selected' : ''}>Delta-validation: already initiated DMs (MessageWorkSpace)</option>
              </select>
            </label>` : ''}
          </div>
          ${dmSource === 'api' ? `
            <div class="report-buttons">
              <button class="btn btn-lg" id="pDmGo" type="button" ${rows.length ? '' : 'disabled'}>Check users and get DM list</button>
            </div>` : `
            <p class="muted">${esc(EXPORT_TIPS[dmSource])}</p>
            <div class="toolbar">
              <span class="muted">Finished DMTODM exports of ${esc(state.adminUser.email)} (ExportChannelsQueue), newest first. Choose one or more.${
                up ? ` Only the DMs of the ${up.rows.length} users in <b>${esc(up.name)}</b> are checked.` : ''}</span>
              <div class="downloads">
                <button class="btn btn-sm btn-quiet" id="exportsAll" type="button">Select all</button>
                <button class="btn" id="jsonBtn" type="button" disabled>Check users and get DM list</button>
              </div>
            </div>
            <div class="choices export-list" id="exportList"><p class="empty">Loading exports…</p></div>`}`
        : `
          <div class="report-buttons">
            <button class="btn btn-lg" id="usersBtn" type="button" ${rows.length ? '' : 'disabled'}>Get auth users list</button>
          </div>`}
        <details class="more"><summary>How users are checked</summary><p class="muted">${how.map(esc).join(' ')}
          Slack token results are cached (CACHE_TTL_MINUTES, 60 by default), so users already checked aren't sent to Slack again when you open the other list.</p></details>
      </section>

      <section class="card">
        <div class="toolbar">
          <div>
            <h2 class="card-title">Mapping <span class="count">${rows.length}</span></h2>
            <p class="muted">${up
              ? `From <b>${esc(up.name)}</b>${up.skipped ? ` · ${up.skipped} rows skipped (invalid email)` : ''} · PermissionCache not used`
              : 'From PermissionCache (IsMapped = true for these admin clouds)'}</p>
          </div>
          <div class="downloads">
            <label class="btn btn-sm btn-quiet" for="mapFile">⬆ ${up ? 'Upload another CSV' : 'Upload mapping CSV'}</label>
            <input id="mapFile" type="file" accept=".csv,text/csv" hidden>
            ${up ? '<button class="btn btn-sm btn-quiet" id="clearUpload" type="button">Use PermissionCache</button>'
              : '<button class="btn btn-sm btn-quiet" id="permCsv" type="button">⬇ Download</button>'}
            <a class="btn btn-sm btn-quiet" href="data:text/csv;charset=utf-8,SourceEmail%2CDestEmail%0D%0Auser%40source.com%2Cuser%40destination.com%0D%0A" download="mapping_template.csv">CSV template</a>
          </div>
        </div>
        ${!up && state.perm.warning ? `<p class="notice error">${esc(state.perm.warning)}</p>` : ''}
        ${rows.length ? `${table}${rows.length > 500 ? `<p class="muted">Showing the first 500 rows. All ${rows.length} are used in the check.</p>` : ''}`
          : '<p class="empty">No mapped users for these admin clouds. Upload a mapping CSV to check specific users.</p>'}
      </section>`;

    $('#back').onclick = () => go(4);
    $('#mapFile').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const { rows: mapped, skipped } = mappingFromCsv(await file.text());
        state.upload = { name: file.name, rows: mapped, skipped };
        toast(`Loaded ${mapped.length} mapped users from ${file.name}${skipped ? ` (${skipped} skipped)` : ''}`);
      } catch (err) { toast(`${file.name}: ${err.message}`, true); }
      viewPermission();
    };
    const clear = $('#clearUpload');
    if (clear) clear.onclick = () => { state.upload = null; viewPermission(); };
    const permCsv = $('#permCsv');
    if (permCsv) permCsv.onclick = async () => {
      const done = busy(permCsv, 'Preparing…');
      try {
        const res = await fetch('/api/permission-cache/csv', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dbId: state.db.id, sourceAdminCloudId: state.src.cloudId, destAdminCloudId: state.dst.cloudId }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
        const url = URL.createObjectURL(await res.blob());
        const a = Object.assign(document.createElement('a'), { href: url, download: 'permission_cache.csv' });
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      } catch (e) { toast(e.message, true); }
      done();
    };
    /** Runs the check for this selection (or reuses a finished one), then opens the report: 6 = users, 7 = SlackDms. */
    const openReport = async (target, btn, extra = null) => {
      const body = {
        codeVersion: state.codeVersion, // not sent for trust (the server uses the session) but part of the reuse key
        dbId: state.db.id, adminUserId: state.adminUser.id, sourceType: state.sourceType, destType: state.destType,
        sourceAdminCloudId: state.src.cloudId, destAdminCloudId: state.dst.cloudId,
        // An uploaded CSV applies to every report type: API approach and both Export-JSON types
        ...(state.upload ? { mapping: state.upload.rows } : {}),
        ...(extra || {}),
      };
      const key = JSON.stringify(body);
      state.tab = target === 7 ? 'dms' : 'users';
      // The JSON approach opens its DM list on the authenticated DMs
      state.dmFilters.authenticated = extra?.mode === 'json' || extra?.dmSource === 'delta' ? 'Yes' : '';
      if (state.jobId && state.jobKey === key && state.job?.status !== 'failed') return go(target);
      const done = busy(btn, 'Starting…');
      try {
        const r = await api('/jobs', { method: 'POST', body });
        Object.assign(state, { jobId: r.jobId, jobKey: key, jobBody: body, job: null, jobDone: false, dmListOn: target === 7 });
        state.pairFilters.page = state.dmFilters.page = 1;
        go(target);
      } catch (e) { toast(e.message, true); done(); }
    };
    if ($('#usersBtn')) $('#usersBtn').onclick = () => openReport(6, $('#usersBtn'));
    view.querySelectorAll('[data-report]').forEach(b => b.onclick = () => { state.reportView = b.dataset.report; viewPermission(); });
    if ($('#pDmFetch')) $('#pDmFetch').onchange = e => { state.dmSource = e.target.value === 'api' ? 'api' : state.lastExportKind || 'onetime'; viewPermission(); };
    if ($('#pExportKind')) $('#pExportKind').onchange = e => { state.dmSource = state.lastExportKind = e.target.value; viewPermission(); };
    // Check the users, then open the chosen DM list
    if ($('#pDmGo')) $('#pDmGo').onclick = () => openReport(7, $('#pDmGo'), { dmSource: 'api' });
    if ($('#exportList')) mountExportPicker(dmSource, (ids, btn) => openReport(7, btn, { dmSource, sessionIds: ids }), 'Check users and get DM list');
  }

  /**
   * Export picker (finished DMTODM exports of the user, newest first) in #exportList, with #exportsAll and
   * #jsonBtn. onRun(sessionIds, button) is called with the ticked exports.
   */
  function mountExportPicker(kind, onRun, label = 'Get auth users DM list') {
    {
      const key = `${state.db.id}|${state.adminUser.id}`;
      if (state.exportsList?.key !== key) state.exportsList = { key, items: null, selected: new Set(), error: '' };
      const ex = state.exportsList;
      const fmt = v => { const d = new Date(v?.$date ?? v); return Number.isNaN(d.getTime()) ? String(v ?? '') : d.toLocaleString(); };
      const paint = () => {
        const list = $('#exportList');
        if (!list) return;
        list.innerHTML = ex.error ? `<p class="notice error">${esc(ex.error)}</p>`
          : !ex.items ? '<p class="empty">Loading exports…</p>'
            : !ex.items.length ? '<p class="empty">No finished DMTODM exports for this user.</p>'
              : ex.items.map(x => `
                <button class="choice" type="button" data-session="${esc(x.sessionId)}" aria-pressed="${ex.selected.has(x.sessionId)}">
                  <span class="tick" aria-hidden="true"></span>
                  <span><span class="email">${esc(x.zipFileName || '(no ZipFileName)')}</span><br><code>SessionId ${esc(x.sessionId)}</code></span>
                  <span class="meta">${esc(fmt(x.createdTime))}</span>
                </button>`).join('');
        list.querySelectorAll('[data-session]').forEach(b => b.onclick = () => {
          const id = b.dataset.session;
          if (ex.selected.has(id)) ex.selected.delete(id); else ex.selected.add(id);
          paint();
        });
        $('#jsonBtn').disabled = !ex.selected.size;
        $('#jsonBtn').textContent = `${label}${ex.selected.size ? ` (${ex.selected.size} export${ex.selected.size === 1 ? '' : 's'})` : ''}`;
        $('#jsonBtn').title = EXPORT_TIPS[kind];
        $('#exportsAll').textContent = ex.items?.length && ex.selected.size === ex.items.length ? 'Clear selection' : 'Select all';
        $('#exportsAll').disabled = !ex.items?.length;
      };
      $('#exportsAll').onclick = () => {
        if (ex.selected.size === ex.items.length) ex.selected.clear();
        else ex.items.forEach(x => ex.selected.add(x.sessionId));
        paint();
      };
      $('#jsonBtn').onclick = () => onRun([...ex.selected], $('#jsonBtn'));
      paint();
      if (!ex.items) {
        api(`/exports?${new URLSearchParams({ dbId: state.db.id, userId: state.adminUser.id })}`)
          .then(r => { ex.items = r.exports.filter(x => x.sessionId); })
          .catch(e => { ex.error = e.message; })
          .finally(paint);
      }
    }
  }

  // ---------- Shared: run log and pager ----------
  const stepsHtml = job => `<ol class="progress">${job.steps.map(s => `
    <li class="${s.status}"><span class="dot"></span><div><div>${esc(s.label)}</div>
    ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</div></li>`).join('')}</ol>`;

  function pagerHtml(p, size) {
    return `<div class="pager-nav">
      <label for="${p}Size" class="hint">Rows per page</label>
      <select id="${p}Size">${[50, 100, 150, 200].map(n => `<option ${size === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <button class="btn btn-quiet" id="${p}First" type="button">First</button>
      <button class="btn btn-quiet" id="${p}Prev" type="button">Previous</button>
      <span id="${p}Info" class="num pg-info"></span>
      <button class="btn btn-quiet" id="${p}Next" type="button">Next</button>
      <button class="btn btn-quiet" id="${p}Last" type="button">Last</button>
    </div>`;
  }

  function wirePager(p, f, load) {
    $(`#${p}Size`).onchange = e => { f.size = Number(e.target.value); f.page = 1; load(); };
    $(`#${p}First`).onclick = () => { f.page = 1; load(); };
    $(`#${p}Prev`).onclick = () => { f.page -= 1; load(); };
    $(`#${p}Next`).onclick = () => { f.page += 1; load(); };
    $(`#${p}Last`).onclick = () => { f.page = f.pages || 1; load(); };
  }

  function updatePager(p, f, r) {
    f.page = r.page; f.pages = r.pages;
    const from = r.filtered ? (r.page - 1) * r.size + 1 : 0, to = Math.min(r.page * r.size, r.filtered);
    $(`#${p}Info`).textContent = r.filtered ? `${from}–${to} of ${r.filtered}, page ${r.page} of ${r.pages}` : 'No rows';
    $(`#${p}First`).disabled = $(`#${p}Prev`).disabled = r.page <= 1;
    $(`#${p}Next`).disabled = $(`#${p}Last`).disabled = r.page >= r.pages;
  }

  function queryOf(f, keys, extra = {}) {
    const all = { ...f, ...extra };
    const p = new URLSearchParams();
    for (const k of keys) if (all[k] !== '' && all[k] != null) p.set(k, all[k]);
    return p.toString();
  }

  const select = (f, id, key, label, opts) => `
    <div class="filter"><label for="${id}">${label}</label>
      <select id="${id}">${opts.map(([v, t]) => `<option value="${v}" ${f[key] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;

  // ---------- 6. Reports: summary cards + Users / SlackDms tabs ----------
  const DM_TYPE_NAMES = {
    im: 'One-to-one', oneOnOne: 'One-to-one', DIRECT_MESSAGE: 'One-to-one',
    mpim: 'Group', group: 'Group', GROUP_CHAT: 'Group',
  };
  const dmTypeName = t => DM_TYPE_NAMES[t] || t || '';
  const jobUrl = path => `/api/jobs/${encodeURIComponent(state.jobId)}${path}`;

  /** A long reason, cut down to a short label for the table; the full text is in the expanded row. */
  function shortReason(text) {
    const t = String(text || '');
    if (!t) return '';
    if (/Billing status DEACTIVATED/.test(t)) return 'Billing deactivated, not provisioned';
    if (/rate limit|unavailable \(/i.test(t)) return 'Slack rate limited, rerun';
    if (/token/i.test(t)) return 'Slack token invalid';
    if (/IsMapped is false/.test(t)) return 'Mapping turned off';
    if (/other admin clouds/.test(t)) return 'Mapped under other clouds';
    if (/not mapped|No source email|No destination email|no destination user/i.test(t)) return 'Not mapped';
    if (/Not found in ProvisionStatus/.test(t)) return 'Not in ProvisionStatus';
    if (/Provisioned is false/.test(t)) return 'Not provisioned';
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }

  const badge = (ok, yes = 'Ready', no = 'Not ready') => `<span class="badge ${ok ? 'b-ok' : 'b-no'}">${ok ? '✓' : '✕'} ${yes && no ? (ok ? yes : no) : ''}</span>`;
  const flagCell = v => (v === 'Yes' ? '<span class="dot-ok" title="Yes">●</span>' : v === 'No' ? '<span class="dot-no" title="No">●</span>'
    : `<span class="muted" title="${esc(v || 'No data')}">–</span>`);

  // Two pages share the same check: 6 = Authentication users, 7 = their SlackDms list
  function viewAuthUsers() { state.tab = 'users'; viewReports(); }
  function viewDmsList() { state.tab = 'dms'; viewReports(); }

  /** Slack auth.test usage of this check (top right of the page); empty when no Slack side was checked with the API. */
  function slackApiHtml(job) {
    const a = job?.slackApi;
    if (!a) return '';
    const tip = `HTTP requests sent to Slack auth.test, retries included. Rate-limited answers: ${a.rateLimited}. Users taken from cache (no call): ${a.fromCache}.`;
    return `<span class="api-count" title="${esc(tip)}">Slack API calls <b>${a.calls}</b>${a.rateLimited ? ` <em>${a.rateLimited} rate-limited</em>` : ''}</span>`;
  }

  /** Runs the same check again without the token cache, so every Slack token is checked live. */
  async function rerunCheck(btn) {
    if (!state.jobBody) return toast('Start the check again from the Permission cache page', true);
    const done = busy(btn, 'Starting…');
    try {
      const r = await api('/jobs', { method: 'POST', body: { ...state.jobBody, fresh: true } });
      Object.assign(state, { jobId: r.jobId, job: null, jobDone: false, dmListOn: !!state.jobBody.dmSource });
      state.pairFilters.page = state.dmFilters.page = 1;
      state.tab = 'users';
      go(6);
    } catch (e) { toast(e.message, true); done(); }
  }

  function viewReports() {
    if (state.job?.id === state.jobId && state.job.status !== 'running') return renderReports(state.job);
    view.innerHTML = `
      <header class="page-head"><div><h1>Running the check</h1>
        <p class="sub">Reading the mapping and ProvisionStatus, checking Slack tokens, then matching the SlackDms. You can leave this page open.</p></div>
        <div class="head-actions" id="jobApi"></div></header>
      <section class="card" id="jobBody"></section>`;
    const poll = async () => {
      try {
        const job = await api(`/jobs/${encodeURIComponent(state.jobId)}`);
        state.job = job;
        if (job.status === 'running') {
          const b = $('#jobBody'); if (b) b.innerHTML = stepsHtml(job);
          const a = $('#jobApi'); if (a) a.innerHTML = slackApiHtml(job);
          return;
        }
        clearInterval(state.pollTimer); state.pollTimer = null;
        state.jobDone = job.status === 'done';
        state.dmListOn = !!job.summary?.dmSource;
        renderRail();
        renderReports(job);
      } catch (e) { toast(e.message, true); clearInterval(state.pollTimer); state.pollTimer = null; }
    };
    poll();
    state.pollTimer = setInterval(poll, 1500);
  }

  function renderReports(job) {
    if (job.status === 'failed') {
      view.innerHTML = `
        <header class="page-head"><div><h1>The check stopped</h1><p class="sub">${esc(job.error)}</p></div>
          <button class="btn" id="retry" type="button">Back to permission cache</button></header>
        <section class="card">${stepsHtml(job)}</section>`;
      $('#retry').onclick = () => go(5);
      return;
    }
    const s = job.summary, p = job.params, tab = state.tab === 'dms' ? 'dms' : 'users';
    // The DM list shown is the one last built: api (SlackDms), onetime (ExportChannelInfo) or delta (MessageWorkSpace)
    const dmMode = s.dmSource === 'delta' ? 'json' : s.dmSource || (p.mode === 'json' ? 'json' : p.mode === 'onetime' ? 'onetime' : 'api');
    const pd = { ...p, mode: dmMode, exports: s.dmSource && s.dmSource !== 'api' ? s.dmExports : p.exports };
    const subP = tab === 'dms' ? pd : p;
    const checked = [`${s.codeVersion === 'new' ? 'New' : 'Old'} code`, ...(job.rerun ? ['Re-run: cache skipped'] : [])].concat(s.sides.filter(x => x.required).map(x => `Checked: ${x.role === 'source' ? 'Source' : 'Destination'} ${typeLabel(x.type)} (${x.useApi ? 'Slack token' : 'ProvisionStatus'})`));
    const cards = tab === 'users'
      ? [['all', s.pairsTotal, 'Mapped users', ''], ['ready', s.pairsReady, 'Ready', 'ok'], ['notready', s.pairsTotal - s.pairsReady, 'Not ready', 'no']]
      : [['all', s.dmsTotal, 'DMs', ''], ['ready', s.dmsReady, 'Ready to initiate', 'ok'], ['notready', s.dmsTotal - s.dmsReady, 'Not ready', 'no'],
        ['unmapped', s.dmsTotal - s.dmsAllMapped, 'Have unmapped users', 'warn']];
    const active = tab === 'users'
      ? (state.pairFilters.ready === 'Yes' ? 'ready' : state.pairFilters.ready === 'No' ? 'notready' : 'all')
      : (state.dmFilters.allMapped === 'No' ? 'unmapped' : state.dmFilters.authenticated === 'Yes' ? 'ready' : state.dmFilters.authenticated === 'No' ? 'notready' : 'all');
    const downloads = tab === 'users'
      ? `<a class="btn btn-sm" href="${jobUrl('/csv/users')}">⬇ All</a>
         <a class="btn btn-sm btn-quiet" href="${jobUrl('/csv/users-ready')}">⬇ Ready</a>
         <a class="btn btn-sm btn-quiet" id="viewCsv" href="#">⬇ Current view</a>`
      : `<a class="btn btn-sm" href="${jobUrl('/csv/dms')}">⬇ All DMs</a>
         <a class="btn btn-sm btn-quiet" href="${jobUrl('/csv/dms-ready')}">⬇ Ready</a>
         <a class="btn btn-sm btn-quiet" href="${jobUrl('/csv/dms-blocked')}">⬇ Not ready</a>
         <a class="btn btn-sm btn-quiet" id="viewCsv" href="#">⬇ Current view</a>`;

    const headActions = tab === 'users'
      ? `<div class="head-actions">
          ${slackApiHtml(job)}
          ${state.jobBody ? '<button class="btn" id="rerunBtn" type="button" title="Check every user again with Slack, ignoring cached results">↻ Re-run check</button>' : ''}
          <button class="btn btn-quiet" id="toPerm" type="button">← Permission cache</button>
          ${s.dmSource ? `<button class="btn btn-quiet" id="toDms" type="button">${dmListName(pd.mode)} <span class="count">${s.dmsTotal}</span> →</button>` : ''}
        </div>`
      : `<div class="head-actions">${slackApiHtml(job)}<button class="btn btn-quiet" id="toUsers" type="button">← Authentication users</button></div>`;

    view.innerHTML = `
      <header class="page-head">
        <div>
          <h1>${tab === 'users' ? 'Authentication users' : pd.mode === 'api' ? 'Authentication users DM list' : dmListName(pd.mode)}</h1>
          <p class="sub">${esc(typeLabel(p.sourceType))} → ${esc(typeLabel(p.destType))} · ${esc(state.db?.name || '')} · ${subP.mode === 'json' || subP.mode === 'onetime' ? `Export-JSON${p.mappingSource === 'Uploaded CSV' ? ' (uploaded CSV users)' : ''} · <span title="${esc(EXPORT_TIPS[subP.mode === 'json' ? 'delta' : 'onetime'])}">${modeLabel(subP.mode)}</span> · ${subP.exports} export${subP.exports === 1 ? '' : 's'}` : `mapping from ${esc(p.mappingSource || 'PermissionCache')}`}
            ${tab === 'dms' ? (pd.mode === 'json' ? ' · already initiated DMs from MessageWorkSpace' : pd.mode === 'onetime' ? ' · ExportChannelInfo DMs of the selected exports' : ' · SlackDms entries of these users (source admin cloud)') : ''}</p>
          <div class="pills">${checked.map(c => `<span class="pill">${esc(c)}</span>`).join('')}${s.sides.some(x => x.required) ? '' : '<span class="pill">No authentication needed</span>'}</div>
        </div>
        ${headActions}
      </header>

      ${tab === 'users' && p.mode !== 'json' ? dmCardHtml(job) : ''}
      ${tab === 'dms' && job.dmError ? `<p class="notice error">The DM list could not be built: ${esc(job.dmError)}</p>` : ''}

      <div class="stat-cards">${cards.map(([key, n, label, tone]) => `
        <button class="stat ${tone ? `s-${tone}` : ''}" type="button" data-card="${key}" aria-pressed="${active === key}">
          <b>${n}</b><span>${label}</span></button>`).join('')}</div>

      <section class="card">
        <div class="toolbar">
          <h2 class="card-title">${tab === 'users' ? 'Mapped users' : dmListName(pd.mode)} <span class="count">${tab === 'users' ? s.pairsTotal : s.dmsTotal}</span></h2>
          <div class="downloads">${downloads}</div>
        </div>
        <div class="filters">${tab === 'users' ? usersFilters() : dmsFilters(pd)}</div>
        <div class="table-bar"><span id="rowCount" class="muted"></span>${pagerHtml('pg', (tab === 'users' ? state.pairFilters : state.dmFilters).size)}</div>
        <div class="table-wrap table-scroll clean" id="tableWrap">${tab === 'users' ? usersTableHead(p) : dmsTableHead(pd)}</div>
        <details class="run-log"><summary>How it ran</summary>${stepsHtml(job)}</details>
      </section>`;

    if ($('#toPerm')) $('#toPerm').onclick = () => go(5);
    if ($('#rerunBtn')) $('#rerunBtn').onclick = () => rerunCheck($('#rerunBtn'));
    if ($('#toDms')) $('#toDms').onclick = () => go(7);
    if ($('#toUsers')) $('#toUsers').onclick = () => go(6);
    if ($('#dmCard')) wireDmCard(job);
    view.querySelectorAll('[data-card]').forEach(b => b.onclick = () => {
      const k = b.dataset.card;
      if (tab === 'users') Object.assign(state.pairFilters, { ready: k === 'ready' ? 'Yes' : k === 'notready' ? 'No' : '', page: 1 });
      else Object.assign(state.dmFilters, { authenticated: k === 'ready' ? 'Yes' : k === 'notready' ? 'No' : '', allMapped: k === 'unmapped' ? 'No' : '', page: 1 });
      renderReports(job);
    });
    const f = tab === 'users' ? state.pairFilters : state.dmFilters;
    const load = tab === 'users' ? loadPairPage : loadDmPage;
    let t;
    $('#f_q').oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; f.page = 1; load(); }, 300); };
    view.querySelectorAll('.filters select[data-key]').forEach(el => el.onchange = e => {
      f[el.dataset.key] = e.target.value; f.page = 1;
      renderReports(job); // keeps the summary cards in step with the filters
    });
    $('#f_clear').onclick = () => {
      Object.assign(f, tab === 'users' ? { q: '', ready: '', page: 1 } : { q: '', type: '', authenticated: '', allMapped: '', page: 1 });
      renderReports(job);
    };
    wirePager('pg', f, load);
    // Click a row to show or hide its details
    $('#tableWrap').onclick = e => {
      const row = e.target.closest('tr.row');
      if (!row || e.target.closest('a')) return;
      const detail = row.nextElementSibling;
      if (detail?.classList.contains('detail')) {
        detail.hidden = !detail.hidden;
        row.classList.toggle('open', !detail.hidden);
      }
    };
    load();
  }

  /**
   * Auth users DM list: built from the users this check already authenticated (no new check).
   * Fetch DMs from API (SlackDms) or Export-JSON (OneTime-Migration-List / Delta-validation, Slack source only).
   */
  function dmCardHtml(job) {
    const slack = job.params.sourceType === 'SLACK';
    if (!slack && state.dmSource && state.dmSource !== 'api') state.dmSource = 'api';
    const src = state.dmSource || 'api';
    return `<section class="card" id="dmCard">
      <div class="toolbar">
        <div>
          <h2 class="card-title">Auth users DM list</h2>
          <p class="muted">Built from the users checked on this page; nobody is checked again.</p>
        </div>
      </div>
      <div class="report-type">
        <label class="filter"><span>Fetch DMs from</span>
          <select id="dmFetch">
            <option value="api" ${src === 'api' ? 'selected' : ''}>API: SlackDms</option>
            <option value="export" ${src !== 'api' ? 'selected' : ''} ${slack ? '' : 'disabled'}>Export-JSON${slack ? '' : ' (Slack source only)'}</option>
          </select>
        </label>
        ${src !== 'api' ? `
        <label class="filter"><span>Export-JSON type</span>
          <select id="exportKind">
            <option value="onetime" ${src === 'onetime' ? 'selected' : ''}>OneTime-Migration-List: ExportChannelInfo</option>
            <option value="delta" ${src === 'delta' ? 'selected' : ''}>Delta-validation: already initiated DMs (MessageWorkSpace)</option>
          </select>
        </label>` : ''}
      </div>
      ${src === 'api' ? `
        <div class="report-buttons"><button class="btn" id="dmGo" type="button">Get auth users DM list</button></div>` : `
        <p class="muted">${esc(EXPORT_TIPS[src])}</p>
        <div class="toolbar">
          <span class="muted">Finished DMTODM exports of ${esc(state.adminUser.email)} (ExportChannelsQueue), newest first. Choose one or more.</span>
          <div class="downloads">
            <button class="btn btn-sm btn-quiet" id="exportsAll" type="button">Select all</button>
            <button class="btn" id="jsonBtn" type="button" disabled>Get auth users DM list</button>
          </div>
        </div>
        <div class="choices export-list" id="exportList"><p class="empty">Loading exports…</p></div>`}
    </section>`;
  }

  function wireDmCard(job) {
    const repaint = () => { $('#dmCard').outerHTML = dmCardHtml(job); wireDmCard(job); };
    $('#dmFetch').onchange = e => { state.dmSource = e.target.value === 'api' ? 'api' : state.lastExportKind || 'onetime'; repaint(); };
    if ($('#exportKind')) $('#exportKind').onchange = e => { state.dmSource = state.lastExportKind = e.target.value; repaint(); };
    const open = async (source, sessionIds, btn) => {
      // The SlackDms list was built with the users: open it straight away
      if (source === 'api' && job.summary.dmSource === 'api' && !job.dmError) { state.tab = 'dms'; return go(7); }
      const done = busy(btn, 'Building…');
      try {
        await api(`/jobs/${encodeURIComponent(state.jobId)}/dm-list`, { method: 'POST', body: { source, sessionIds } });
        Object.assign(state.dmFilters, { q: '', type: '', allMapped: '', authenticated: source === 'delta' ? 'Yes' : '', page: 1 });
        state.job = null; // poll the rebuilt list
        state.dmListOn = true;
        state.tab = 'dms';
        go(7);
      } catch (e) { toast(e.message, true); done(); }
    };
    if ($('#dmGo')) $('#dmGo').onclick = () => open('api', [], $('#dmGo'));
    if ($('#exportList')) mountExportPicker(state.dmSource, (ids, btn) => open(state.dmSource, ids, btn));
  }

  const filterSelect = (f, key, label, opts) => `
    <label class="filter"><span>${label}</span>
      <select data-key="${key}">${opts.map(([v, t]) => `<option value="${v}" ${f[key] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;

  function usersFilters() {
    const f = state.pairFilters;
    return `<label class="filter filter-wide"><span>Search</span><input id="f_q" type="search" value="${esc(f.q)}" placeholder="Email, cloud or reason"></label>
      ${filterSelect(f, 'ready', 'Status', [['', 'All'], ['Yes', 'Ready'], ['No', 'Not ready']])}
      <button class="btn btn-sm btn-quiet" id="f_clear" type="button">Clear</button>`;
  }

  function dmsFilters(p) {
    const f = state.dmFilters, types = p.mode === 'json' || p.mode === 'onetime' ? [] : state.dmTypes?.[p.sourceType] || [];
    return `<label class="filter filter-wide"><span>Search</span><input id="f_q" type="search" value="${esc(f.q)}" placeholder="DM name, email, FromRootId or reason"></label>
      ${types.length ? filterSelect(f, 'type', 'Type', [['', 'All'], ...types.map(t => [t, dmTypeName(t)])]) : ''}
      ${filterSelect(f, 'authenticated', 'Status', [['', 'All'], ['Yes', 'Ready'], ['No', 'Not ready']])}
      ${filterSelect(f, 'allMapped', 'Mapping', [['', 'All'], ['Yes', 'All mapped'], ['No', 'Has unmapped']])}
      <button class="btn btn-sm btn-quiet" id="f_clear" type="button">Clear</button>`;
  }

  const usersTableHead = p => (p.mode === 'json' ? `<table>
      <thead>
        <tr class="grp"><th colspan="4">Source · Slack (Clouds + auth.test)</th><th colspan="${state.job?.summary?.sides?.[1]?.required ? 2 : 1}" class="grp-split">Destination · ${esc(typeLabel(p.destType))}</th><th colspan="2"></th></tr>
        <tr><th>Source Email</th><th class="c">Cloud status</th><th class="c">Billing status</th><th>Slack token</th>
          <th class="grp-split">Destination Email</th>${state.job?.summary?.sides?.[1]?.required ? '<th class="c">Provisioned</th>' : ''}
          <th>Status</th><th class="chev"></th></tr>
      </thead>
      <tbody id="rows"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody></table>` : `<table>
      <thead>
        <tr class="grp"><th colspan="4">Source · ${esc(typeLabel(p.sourceType))}</th><th colspan="4" class="grp-split">Destination · ${esc(typeLabel(p.destType))}</th><th colspan="2"></th></tr>
        <tr><th>Source Email</th><th title="Cloud name, cloud status and billing status">Cloud · status · billing</th><th class="c" title="EmailSent">Sent</th><th class="c" title="Provisioned">Prov.</th>
          <th class="grp-split">Destination Email</th><th title="Cloud name, cloud status and billing status">Cloud · status · billing</th><th class="c" title="EmailSent">Sent</th><th class="c" title="Provisioned">Prov.</th>
          <th>Status</th><th class="chev"></th></tr>
      </thead>
      <tbody id="rows"><tr><td colspan="10" class="empty">Loading…</td></tr></tbody></table>`);

  const dmsTableHead = p => `<table>
      <thead><tr><th>DM name</th><th>${p?.mode === 'json' ? 'SessionId' : p?.mode === 'onetime' ? 'ChannelId' : 'FromRootId'}</th><th>Ready to initiate</th><th>If not, why not</th><th class="c">Is mapped</th>
        <th class="c">No. of users provisioned</th><th>Users not provisioned (reason)</th><th class="chev"></th></tr></thead>
      <tbody id="rows"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody></table>`;

  /** Yes / No / Not found as a small text badge (EmailSent, Provisioned, Is mapped). */
  const yn = v => (v === 'Yes' ? '<span class="yn y">Yes</span>' : v === 'No' ? '<span class="yn n">No</span>'
    : `<span class="yn na">${esc(v || '—')}</span>`);

  function setCount(r, noun) {
    $('#rowCount').textContent = r.filtered === r.total ? `${r.total} ${noun}` : `${r.filtered} of ${r.total} ${noun}`;
  }

  async function loadPairPage() {
    const tbody = $('#rows');
    if (!tbody) return;
    const f = state.pairFilters, keys = ['q', 'ready', 'page', 'size'];
    try {
      const r = await api(`/jobs/${encodeURIComponent(state.jobId)}/pairs?${queryOf(f, keys)}`);
      updatePager('pg', f, r);
      setCount(r, 'mapped users');
      const csvQ = queryOf(f, keys, { page: '', size: '' });
      $('#viewCsv').href = jobUrl(`/csv/users${csvQ ? '?' + csvQ : ''}`);
      const jsonMode = state.job?.params?.mode === 'json';
      const teamsDest = state.job?.summary?.sides?.[1]?.required;
      const tokenText = t => (!t ? '—' : t === 'Valid' ? '<span class="yn y">Valid</span>' : `<span class="yn n">${esc(shortReason(t) || t)}</span>`);
      if (jsonMode) {
        tbody.innerHTML = r.rows.length ? r.rows.map(x => {
          const ok = x.ready === 'Yes';
          return `<tr class="row">
            <td class="email">${esc(x.sourceEmail || '—')}</td>
            <td class="c">${yn(x.sourceCloudStatus ? (x.sourceCloudStatus === 'ACTIVE' ? 'Yes' : 'No') : '')}<div class="muted">${esc(x.sourceCloudStatus)}</div></td>
            <td class="c">${yn(x.sourceBillingStatus ? (x.sourceBillingStatus === 'ACTIVE' ? 'Yes' : 'No') : '')}<div class="muted">${esc(x.sourceBillingStatus)}</div></td>
            <td>${tokenText(x.sourceTokenCheck)}</td>
            <td class="email grp-split">${esc(x.destEmail || '—')}</td>
            ${teamsDest ? `<td class="c">${yn(x.destProvisioned)}</td>` : ''}
            <td>${badge(ok)}${ok ? '' : `<div class="why">${esc(shortReason(x.reason))}</div>`}</td>
            <td class="chev">${ok ? '' : '<span>›</span>'}</td></tr>
            ${ok ? '' : `<tr class="detail" hidden><td colspan="8">${esc(x.reason).split('; ').join('<br>')}
              ${x.sourceTokenCheck ? `<div class="muted">Slack token: ${esc(x.sourceTokenCheck)}</div>` : ''}</td></tr>`}`;
        }).join('') : '<tr><td colspan="8" class="empty">No users match these filters.</td></tr>';
        $('#tableWrap').scrollTop = 0;
        return;
      }
      tbody.innerHTML = pairRowsHtml(r.rows);
      $('#tableWrap').scrollTop = 0;
    } catch (e) { toast(e.message, true); }
  }

  /** Rows of the auth users table (one per mapping), shared by the Authentication users page and the DM list page. */
  function pairRowsHtml(rows) {
    // Cloud name, then its cloud status and billing status (from Clouds); anything not ACTIVE stands out
    const st = (label, v) => (v ? `<span class="${v === 'ACTIVE' ? '' : 'why'}" title="${label} status: ${esc(v)}">${esc(v)}</span>` : '');
    const cloudCell = (name, cs, bs) => `<td class="cloud-cell"><span class="muted">${esc(name || '—')}</span>
      ${cs || bs ? `<div class="cloud-st">${[st('Cloud', cs), st('Billing', bs)].filter(Boolean).join(' · ')}</div>` : ''}${
      /^DEACTIVAT/i.test(bs || '') ? '<div class="why" title="Billing status DEACTIVATED: ProvisionStatus decides, no Slack check">ProvisionStatus used</div>' : ''}</td>`;
    return rows.length ? rows.map(x => {
      const ok = x.ready === 'Yes';
      return `<tr class="row">
        <td class="email">${esc(x.sourceEmail || '—')}</td>
        ${cloudCell(x.sourceCloud, x.sourceCloudStatus, x.sourceBillingStatus)}
        <td class="c">${yn(x.sourceEmailSent)}</td><td class="c">${yn(x.sourceProvisioned)}</td>
        <td class="email grp-split">${esc(x.destEmail || '—')}</td>
        ${cloudCell(x.destCloud, x.destCloudStatus, x.destBillingStatus)}
        <td class="c">${yn(x.destEmailSent)}</td><td class="c">${yn(x.destProvisioned)}</td>
        <td>${badge(ok)}${ok ? '' : `<div class="why">${esc(shortReason(x.reason))}</div>`}</td>
        <td class="chev">${ok ? '' : '<span>›</span>'}</td></tr>
        ${ok ? '' : `<tr class="detail" hidden><td colspan="10">${esc(x.reason).split('; ').join('<br>')}
          ${x.sourceTokenCheck || x.destTokenCheck ? `<div class="muted">Slack token: ${esc([x.sourceTokenCheck && `source ${x.sourceTokenCheck}`, x.destTokenCheck && `destination ${x.destTokenCheck}`].filter(Boolean).join(' · '))}</div>` : ''}</td></tr>`}`;
    }).join('') : '<tr><td colspan="10" class="empty">No mapped users match these filters.</td></tr>';
  }

  async function loadDmPage() {
    const tbody = $('#rows');
    if (!tbody) return;
    const f = state.dmFilters, keys = ['q', 'type', 'authenticated', 'allMapped', 'page', 'size'];
    try {
      const r = await api(`/jobs/${encodeURIComponent(state.jobId)}/dms?${queryOf(f, keys)}`);
      updatePager('pg', f, r);
      setCount(r, 'DMs');
      const csvQ = queryOf(f, keys, { page: '', size: '' });
      $('#viewCsv').href = jobUrl(`/csv/dms${csvQ ? '?' + csvQ : ''}`);
      tbody.innerHTML = r.rows.length ? r.rows.map(d => `<tr class="row">
          <td><div class="email">${esc(d.channelName || '—')}</div><div class="muted">${esc(dmTypeName(d.type))}</div></td>
          <td><code class="muted">${esc(d.fromRootId)}</code></td>
          <td>${badge(d.allReady, 'Yes', 'No')}</td>
          <td>${d.whyNot ? esc(d.whyNot) : '<span class="muted">—</span>'}</td>
          <td class="c">${yn(d.allMapped)}</td>
          <td class="c num">${esc((d.authenticatedCount || '').replace(' of ', ' / '))}</td>
          <td class="np">${(d.people || []).filter(x => !x.ok).map(x => `<div><span class="email">${esc(x.email)}</span>
            <span class="why">${esc(shortReason(x.reason))}</span></div>`).join('') || '<span class="muted">—</span>'}</td>
          <td class="chev"><span>›</span></td></tr>
        <tr class="detail" hidden><td colspan="8"><ul class="people">${(d.people || []).map(x => `
          <li class="${x.ok ? 'ok' : 'no'}"><span class="mark">${x.ok ? '✓' : '✕'}</span>
            <span class="email">${esc(x.email)}</span>${x.dest ? ` <span class="muted">→ ${esc(x.dest)}</span>` : ''}
            ${x.ok ? '' : `<div class="why">${esc(x.reason)}</div>`}</li>`).join('') || '<li class="muted">No participant emails</li>'}</ul></td></tr>`).join('')
        : '<tr><td colspan="8" class="empty">No SlackDms match these filters.</td></tr>';
      $('#tableWrap').scrollTop = 0;
    } catch (e) { toast(e.message, true); }
  }

  $('#logoutBtn').onclick = async () => {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    // Forget everything read with the previous account
    Object.assign(state, {
      user: null, databases: [], db: null, sourceType: 'SLACK', destType: '',
      adminEmail: '', adminUser: null, clouds: [], src: null, dst: null,
      perm: null, jobId: null, job: null, jobDone: false, dmListOn: false,
      userList: { ...state.userList, dbId: null, q: '', users: [], total: 0 },
      pairFilters: { q: '', ready: '', page: 1, size: 50 }, tab: 'users', jobKey: '', jobBody: null,
      dmFilters: { q: '', type: '', apiCallHit: '', authenticated: '', allMapped: '', page: 1, size: 50 },
      switchAccount: true, upload: null,
    });
    go(0);
    toast(state.apiKeyMode
      ? 'Signed out. This server uses METABASE_API_KEY, so the same key is used on the next sign-in.'
      : 'Signed out of Metabase. Sign in with another account.');
  };

  (async function init() {
    try {
      const me = await api('/auth/me');
      state.apiKeyMode = me.apiKeyMode; state.appPassword = !!me.appPassword; state.metabaseUrl = me.metabaseUrl;
      state.codeVersion = me.codeVersion === 'new' ? 'new' : 'old';
      if (me.signedIn) { state.user = me.user; await loadDatabases(); go(1); return; }
    } catch { /* show connect */ }
    go(0);
  })();
})();
