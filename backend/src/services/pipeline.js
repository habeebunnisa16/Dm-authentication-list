const config = require('../config');
const q = require('./queries');
const { checkProvisioning, checkSlackTokens } = require('./validator');
const { authRequired } = require('./rules');
const { cache } = require('./store');
const { extractEmails, uniq } = require('../utils/helpers');

const isSlack = t => String(t).toUpperCase() === 'SLACK';

function step(job, key, label) {
  const s = { key, label, status: 'running', done: 0, total: 0, note: '' };
  job.steps.push(s);
  return s;
}

/**
 * Slack token checks (auth.test) for one side, reusing fresh cached results.
 * Cache entries are keyed "role|email", since Slack to Slack has the same emails on both sides.
 * A re-run (job.params.fresh) ignores the cache and checks every token again; its results refresh the cache.
 */
async function tokensWithCache(ctx, job, side, s) {
  const { dbId, sourceAdminCloudId, destAdminCloudId, cacheOwner, fresh: rerun } = job.params;
  const key = e => `${side.role}|${e}`;
  const cached = rerun ? {} : cache.load(dbId, sourceAdminCloudId, destAdminCloudId, cacheOwner);
  const all = new Map();
  const todo = [];
  for (const e of uniq(side.emails)) {
    if (cached[key(e)]) all.set(e, cached[key(e)]);
    else todo.push(e);
  }
  s.note = rerun ? `Re-run: cache skipped, ${todo.length} to check` : `${all.size} from cache, ${todo.length} to check`;
  // Slack API usage for the whole check: HTTP requests sent (retries included), rate-limited answers, cache hits
  job.slackApi ||= { calls: 0, rateLimited: 0, fromCache: 0 };
  job.slackApi.fromCache += all.size;
  const onApiCall = event => {
    if (event === 'request') job.slackApi.calls++;
    else if (event === 'ratelimited') job.slackApi.rateLimited++;
  };
  const fresh = await checkSlackTokens(ctx, todo, side.adminCloudId, p => {
    s.done = p.done; s.total = p.total;
    s.note = `${all.size} from cache, calling Slack auth.test (${p.done}/${p.total})`;
  }, { ...side.opts, onApiCall });
  for (const [e, r] of fresh) { r.checkedAt = Date.now(); all.set(e, r); }
  // Results cut short by a Slack rate limit or outage aren't cached, so the next run checks them again
  cache.save(dbId, sourceAdminCloudId, destAdminCloudId,
    new Map([...fresh].filter(([, r]) => !r.transient).map(([e, r]) => [key(e), r])), cacheOwner);
  const v = [...all.values()];
  const unchecked = v.filter(r => r.transient).length;
  s.note = `${v.length} ${side.role} users: ${v.filter(r => r.apiCalled).length} sent to auth.test, `
    + `${v.filter(r => r.tokenValid).length} valid tokens`
    + (unchecked ? `. ${unchecked} not checked because Slack kept rate limiting or was unavailable; rerun to check them` : '');
  return all;
}

/**
 * Whether one user counts as authenticated, given their side's rule:
 * - side doesn't need authentication → "Not required" (counts as ready)
 * - Slack side checked with the API → the token must pass auth.test (a password change revokes it),
 *   except when the cloud's billingStatus is DEACTIVATED: no API call, ProvisionStatus decides
 * - otherwise → ProvisionStatus.provisioned = true
 */
function decide(r, side) {
  if (!side.required) return { status: 'Not required', authenticated: true, reason: 'Authentication is not needed on this side' };
  if (side.useApi && r.billingDeactivated) {
    return r.provisioned
      ? { status: 'Authenticated', authenticated: true, reason: 'Billing status DEACTIVATED: Provisioned in ProvisionStatus (no Slack check)' }
      : { status: 'Not authenticated', authenticated: false, reason: `Billing status DEACTIVATED: ${r.reason || 'not provisioned'} (no Slack check)` };
  }
  if (side.useApi) {
    if (r.tokenValid) return { status: 'Authenticated', authenticated: true, reason: 'Slack token is valid (auth.test)' };
    const why = !r.tokenCheck ? 'Slack token not checked'
      : r.tokenCheck.startsWith('Invalid') ? `Slack token rejected by auth.test (${r.slackError || r.tokenCheck.replace(/^Invalid:\s*/, '')}), e.g. password changed or app removed`
        : r.tokenCheck.replace(/^Not called:\s*/, 'Slack token not checked: ');
    return { status: 'Not authenticated', authenticated: false, reason: why };
  }
  return r.provisioned
    ? { status: 'Authenticated', authenticated: true, reason: 'Provisioned' }
    : { status: 'Not authenticated', authenticated: false, reason: r.reason };
}

const typeName = t => config.cloudTypes.find(x => x.value === String(t).toUpperCase())?.label || t;

/** Checks users' authentication for one source → destination combination, then their SlackDms. */
async function runReport(baseCtx, job) {
  const { dbId, adminUserId, sourceAdminCloudId, destAdminCloudId, sourceType, destType } = job.params;
  const ctx = { ...baseCtx, dbId };
  const need = authRequired(sourceType, destType, job.params.codeVersion);
  try {
    // 1. Mapped users: the uploaded CSV when there is one, otherwise PermissionCache
    //    (SourceAdminCloudId + DestAdminCloudId + IsMapped = true)
    const fromCsv = Array.isArray(job.params.mapping);
    const oneTime = job.params.mode === 'onetime'; // Export-JSON OneTime-Migration: DMs from ExportChannelInfo
    const dmTypes = config.dmTypes[String(sourceType).toUpperCase()] ?? null;
    const emailsOf = d => uniq([...extractEmails(d.emailPairs), ...extractEmails(d.emailIds)]);
    let s = step(job, 'mapped', fromCsv ? 'Read the uploaded CSV, their SlackDms, and the mapping of the other DM participants'
      : 'Read mapped users from PermissionCache');
    let mapped, csvDms = null;
    if (fromCsv) {
      // Only the DMs that involve an uploaded user. Their other participants may be mapped in PermissionCache
      // without being in the CSV, so their mapping comes from there (and they get the same checks).
      const csv = job.params.mapping;
      const csvSet = new Set(csv.map(r => r.sourceEmail));
      // DMs may list users by their destination email, so those count as the uploaded users too
      const csvAny = new Set([...csvSet, ...csv.map(r => r.destEmail).filter(Boolean)]);
      const all = job.params.dmSource === 'delta'
        ? (await q.findMessageWorkspaces(ctx.token, dbId, adminUserId, job.params.sessionIds)).map(w => ({ emailPairs: w.emailPairs, emailIds: [] }))
        : oneTime ? await q.findExportChannelInfo(ctx.token, dbId, adminUserId, job.params.sessionIds)
        : await q.findSlackDms(ctx.token, dbId, adminUserId, sourceAdminCloudId, dmTypes);
      csvDms = all.filter(d => emailsOf(d).some(e => csvAny.has(e)));
      const others = new Set(csvDms.flatMap(emailsOf).filter(e => !csvAny.has(e)));
      const extra = others.size
        ? (await q.findPermissionCache(ctx.token, dbId, sourceAdminCloudId, destAdminCloudId).catch(() => []))
          .filter(r => others.has(r.sourceEmail) || others.has(r.destEmail))
        : [];
      mapped = [...csv, ...extra];
      s.note = `${csv.length} rows in the CSV. ${csvDms.length} of ${all.length} ${oneTime ? 'ExportChannelInfo DMs' : 'SlackDms'} involve these users. `
        + `${uniq(extra.map(r => r.sourceEmail)).length} other participants are mapped in PermissionCache.`;
    } else {
      mapped = await q.findPermissionCache(ctx.token, dbId, sourceAdminCloudId, destAdminCloudId);
    }
    const sourceEmails = uniq(mapped.map(m => m.sourceEmail).filter(Boolean));
    const destEmails = uniq(mapped.map(m => m.destEmail).filter(Boolean));
    s.status = 'done'; s.total = s.done = mapped.length;
    if (!fromCsv) s.note = `${mapped.length} mapped rows: ${sourceEmails.length} source users, ${destEmails.length} destination users`;
    if (mapped.length && !sourceEmails.length) {
      throw new Error('PermissionCache rows have no source email. Fix permissionCache.sourceEmail in config.js (see Check field names) and restart.');
    }

    // 2. ProvisionStatus for both sides, each under its own AdminCloudId
    s = step(job, 'provision', 'Check ProvisionStatus for source and destination users');
    const sides = [
      { role: 'source', type: sourceType, adminCloudId: sourceAdminCloudId, emails: sourceEmails },
      { role: 'destination', type: destType, adminCloudId: destAdminCloudId, emails: destEmails },
    ];
    for (const side of sides) {
      side.required = need[side.role];
      // Slack sides that need authentication are checked live with auth.test
      side.useApi = side.required && isSlack(side.type);
      side.users = await checkProvisioning(ctx, side.emails, side.adminCloudId, side.role);
    }
    const [src, dst] = sides;
    const provisioned = m => [...m.values()].filter(r => r.provisioned).length;
    s.status = 'done'; s.total = s.done = src.users.size + dst.users.size;
    s.note = `Source: ${provisioned(src.users)} of ${src.users.size} provisioned. Destination: ${provisioned(dst.users)} of ${dst.users.size} provisioned.`;

    // Cloud and billing status of every mapped user, from Clouds under that side's admin cloud (no authentication call)
    s = step(job, 'clouds', 'Read cloud and billing status from Clouds');
    const norm = v => String(v ?? '').trim().toUpperCase();
    for (const side of sides) {
      const byEmail = new Map();
      for (const c of side.emails.length ? await q.findCloudsByEmails(ctx.token, dbId, side.emails) : []) {
        if (c.adminCloudId !== String(side.adminCloudId)) continue;
        const cur = byEmail.get(c.email);
        // Prefer the cloud of this side's type (e.g. the SLACK cloud on a Slack side)
        if (!cur || (norm(cur.cloudName) !== norm(side.type) && norm(c.cloudName) === norm(side.type))) byEmail.set(c.email, c);
      }
      for (const r of side.users.values()) {
        const c = byEmail.get(r.email);
        Object.assign(r, { cloudStatus: c ? norm(c.cloudStatus) : '', billingStatus: c ? norm(c.billingStatus) : '', cloudsName: c?.cloudName || '' });
      }
    }
    s.status = 'done'; s.total = s.done = src.users.size + dst.users.size;
    s.note = 'Cloud status and billing status read for both sides';

    // 3. Slack token checks for the Slack sides that need them
    for (const side of sides) {
      for (const r of side.users.values()) {
        Object.assign(r, { tokenCheck: '', apiCalled: false, tokenValid: false, slackError: '', slackUserId: '', slackTeam: '' });
      }
      if (!side.useApi) continue;
      s = step(job, `slack-${side.role}`, `Check Slack tokens of ${side.role} users (auth.test)`);
      const tokens = await tokensWithCache(ctx, job, side, s);
      for (const [e, t] of tokens) {
        const u = side.users.get(e);
        Object.assign(u, {
          tokenCheck: t.tokenCheck, apiCalled: t.apiCalled, tokenValid: t.tokenValid,
          slackError: t.slackError, slackUserId: t.slackUserId, slackTeam: t.slackTeam,
          billingDeactivated: !!t.billingDeactivated, cloudStatus: t.cloudStatus || u.cloudStatus || '', billingStatus: t.billingStatus || u.billingStatus || '',
        });
      }
      s.status = 'done';
    }

    // Decide each user, and pair them with the other side of their mapping
    const pairOf = { source: new Map(), destination: new Map() };
    for (const m of mapped) {
      if (m.sourceEmail && m.destEmail) {
        pairOf.source.set(m.sourceEmail, m.destEmail);
        pairOf.destination.set(m.destEmail, m.sourceEmail);
      }
    }
    for (const side of sides) {
      for (const r of side.users.values()) {
        Object.assign(r, decide(r, side), { cloudType: side.type, required: side.required, mappedTo: pairOf[side.role].get(r.email) || '' });
      }
    }
    job.users = [...src.users.values(), ...dst.users.values()];

    // One row per mapping: the source user and the destination user side by side
    // (with a CSV, only its rows; the PermissionCache rows added for other DM participants aren't listed)
    const seenPair = new Set();
    job.pairs = [];
    for (const m of fromCsv ? job.params.mapping : mapped) {
      const k = `${m.sourceEmail}|${m.destEmail}`;
      if (seenPair.has(k)) continue;
      seenPair.add(k);
      const sr = src.users.get(m.sourceEmail), dr = dst.users.get(m.destEmail);
      const why = [];
      if (!m.sourceEmail) why.push(`No source email in ${job.params.mappingSource || 'PermissionCache'}`);
      if (!m.destEmail) why.push(`No destination email in ${job.params.mappingSource || 'PermissionCache'}`);
      if (src.required && sr && !sr.authenticated) why.push(`Source ${typeName(src.type)}: ${sr.reason}`);
      if (dst.required && dr && !dr.authenticated) why.push(`Destination ${typeName(dst.type)}: ${dr.reason}`);
      const flags = (r, prefix) => ({
        [`${prefix}Email`]: r?.email || '',
        [`${prefix}Cloud`]: r?.cloudName || r?.cloudsName || '',
        [`${prefix}EmailSent`]: !r ? '' : r.inProvisionStatus ? (r.emailSent ? 'Yes' : 'No') : 'Not found',
        [`${prefix}Provisioned`]: !r ? '' : r.inProvisionStatus ? (r.provisioned ? 'Yes' : 'No') : 'Not found',
        [`${prefix}Status`]: r?.status || '',
        [`${prefix}TokenCheck`]: r?.tokenCheck || '',
        [`${prefix}CloudStatus`]: r?.cloudStatus || '',
        [`${prefix}BillingStatus`]: r?.billingStatus || '',
      });
      job.pairs.push({
        ...flags(sr, 'source'),
        ...flags(dr, 'dest'),
        sourceEmail: m.sourceEmail,
        destEmail: m.destEmail,
        ready: why.length ? 'No' : 'Yes',
        reason: why.join('; '),
      });
    }

    const sideSummary = side => ({
      role: side.role,
      type: side.type,
      required: side.required,
      useApi: side.useApi,
      users: side.users.size,
      authenticated: [...side.users.values()].filter(r => r.status === 'Authenticated').length,
      tokensInvalid: [...side.users.values()].filter(r => r.apiCalled && !r.tokenValid).length,
    });
    job.summary = { mode: job.params.mode || 'api', codeVersion: job.params.codeVersion || 'old', sides: sides.map(sideSummary) };

    // Context kept on the job (not sent to the browser), so a DM list can be built later for another DM source
    // without checking the users again
    Object.defineProperty(job, 'ctx', {
      value: {
        sides, src, dst, pairOf, sourceEmails, destEmails, fromCsv,
        csvAny: fromCsv ? new Set(job.params.mapping.flatMap(r => [r.sourceEmail, r.destEmail]).filter(Boolean)) : null,
      },
      enumerable: false, writable: true, configurable: true,
    });
    Object.assign(job.summary, { pairsTotal: job.pairs.length, pairsReady: job.pairs.filter(p => p.ready === 'Yes').length });

    // 4-5. DMs matched to the checked users, only when a DM list was asked for ("Auth users DM list").
    // "Auth users list" stops here; the DM list is built later from job.ctx (POST /jobs/:id/dm-list).
    const firstList = job.params.dmSource || (oneTime ? 'onetime' : null);
    if (firstList) {
      // The CSV pre-read in step 1 only has the DM shape for SlackDms / ExportChannelInfo; Delta-validation reads its own
      await buildDmList(ctx, job, firstList, job.params.sessionIds, firstList === 'delta' ? null : csvDms);
    } else {
      Object.assign(job.summary, { dmSource: null, dmsTotal: 0, dmsAllMapped: 0, dmsReady: 0 });
    }
    job.status = 'done';
  } catch (e) {
    const running = job.steps.find(x => x.status === 'running');
    console.error(`Check ${job.id} failed (${sourceType} → ${destType}, step "${running?.label || '?'}"):`, e.stack || e);
    if (running) { running.status = 'failed'; running.note = e.message; }
    job.status = 'failed';
    job.error = e.message;
    if (e.status === 401) job.error = 'Metabase session expired. Sign in again and rerun.';
  }
}

/**
 * Builds job.dms from one DM source, using the users already checked by runReport (job.ctx): no Slack or
 * ProvisionStatus call is made here.
 *   api     SlackDms of the source admin cloud
 *   onetime ExportChannelInfo of the selected exports (sessionId, dm = true): OneTime-Migration-List
 *   delta   MessageWorkSpace of the selected exports (already initiated DMs): Delta-validation
 * With an uploaded CSV, only the DMs that involve an uploaded user are kept.
 */
async function buildDmList(ctx, job, source, sessionIds, preloaded = null) {
  const { dbId, adminUserId, sourceAdminCloudId, destAdminCloudId, sourceType } = job.params;
  const { sides, src, dst, pairOf, sourceEmails, destEmails, fromCsv, csvAny } = job.ctx;
  const dmTypes = config.dmTypes[String(sourceType).toUpperCase()] ?? null;
  const who = fromCsv ? ' of the uploaded users' : '';
  let s = step(job, 'dms', source === 'onetime' ? `ExportChannelInfo DMs${who} for the selected exports (dm = true)`
    : source === 'delta' ? `Already initiated DMs${who} from MessageWorkSpace for the selected exports`
      : `SlackDms${who} for the source admin cloud${dmTypes ? ` (${dmTypes.join(', ')})` : ''}`);
  let dms = preloaded;
  if (!dms) {
    if (source === 'onetime') dms = await q.findExportChannelInfo(ctx.token, dbId, adminUserId, sessionIds);
    else if (source === 'delta') {
      dms = (await q.findMessageWorkspaces(ctx.token, dbId, adminUserId, sessionIds)).map(w => ({
        dmId: w.id, channelName: w.channelName, fromRootId: w.sessionId, type: w.processStatus, emailPairs: w.emailPairs, emailIds: [],
      }));
    } else dms = await q.findSlackDms(ctx.token, dbId, adminUserId, sourceAdminCloudId, dmTypes);
    if (csvAny) dms = dms.filter(d => [...extractEmails(d.emailPairs), ...extractEmails(d.emailIds)].some(e => csvAny.has(e)));
  }
  const byType = {};
  for (const d of dms) byType[d.type || '(none)'] = (byType[d.type || '(none)'] || 0) + 1;
  s.status = 'done'; s.total = s.done = dms.length;
  s.note = `${dms.length} DMs. Types: ${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`;

  // 5. Each participant must be a mapped source user, and pass the rule on every side that needs it
  s = step(job, 'participants', 'Match DM participants to mapped users and check authentication');
  // EmailPairs / EmailIds can hold source emails, source → destination pairs, or only the destination emails.
  // An email that is only a mapped destination user stands for its mapped source user, so it's translated
  // back instead of being reported as "not mapped" (and a pair collapses to one participant).
  const sourceSet = new Set(sourceEmails);
  const destOnly = new Set(destEmails.filter(e => !sourceSet.has(e)));
  let translatedDest = 0;
  for (const d of dms) {
    const found = uniq([...extractEmails(d.emailPairs), ...extractEmails(d.emailIds)]);
    d.mappedDestEmails = found.filter(e => destOnly.has(e));
    translatedDest += d.mappedDestEmails.length;
    d.participants = uniq(found.map(e => (destOnly.has(e) ? pairOf.destination.get(e) || e : e)));
  }
  // A participant that isn't mapped but shares its name with a mapped source user is probably an alias or another domain
  const byLocal = new Map();
  for (const e of sourceEmails) {
    const local = e.split('@')[0];
    byLocal.set(local, [...(byLocal.get(local) || []), e]);
  }
  // DMs without readable emails are reported as such (Ready = No) rather than stopping the whole check
  const noEmails = dms.filter(d => !d.participants.length);
  const sample = noEmails[0] ? `e.g. EmailPairs = ${JSON.stringify(noEmails[0].emailPairs ?? null).slice(0, 160)}, `
    + `EmailIds = ${JSON.stringify(noEmails[0].emailIds ?? null).slice(0, 160)}` : '';
  const apiSides = sides.filter(x => x.useApi);
  const raw = v => (v == null ? '' : Array.isArray(v) ? v.map(x => (typeof x === 'object' ? JSON.stringify(x) : x)).join(', ')
    : typeof v === 'object' ? JSON.stringify(v) : String(v));

  // Why each unmapped participant didn't match: look them up in PermissionCache whatever the clouds or IsMapped
  const unmapped = uniq(dms.flatMap(d => d.participants.filter(e => !src.users.has(e))));
  const pcRows = new Map();
  if (unmapped.length) {
    const all = await q.findPermissionCacheByEmails(ctx.token, dbId, unmapped).catch(() => []);
    for (const r of all) pcRows.set(r.sourceEmail, [...(pcRows.get(r.sourceEmail) || []), r]);
  }
  const whyUnmapped = e => {
    const rows = pcRows.get(e) || [];
    const here = rows.filter(r => r.sourceAdminCloudId === String(sourceAdminCloudId) && r.destAdminCloudId === String(destAdminCloudId));
    const parts = [];
    if (fromCsv) parts.push('not in the uploaded CSV, and not mapped in PermissionCache for these admin clouds');
    if (here.some(r => !r.isMapped)) parts.push('PermissionCache has a row for these admin clouds but IsMapped is false');
    else if (here.length) parts.push('PermissionCache has a mapped row for these admin clouds');
    const elsewhere = rows.filter(r => !here.includes(r));
    if (elsewhere.length) {
      const where = uniq(elsewhere.map(r => `${r.sourceAdminCloudId} → ${r.destAdminCloudId}${r.isMapped ? '' : ' (IsMapped false)'}`));
      parts.push(`PermissionCache maps this email under other admin clouds: ${where.slice(0, 3).join('; ')}${where.length > 3 ? '…' : ''}`);
    }
    if (!rows.length) parts.push('no PermissionCache row has this source email');
    const alike = byLocal.get(e.split('@')[0]) || [];
    if (alike.length) parts.push(`a mapped source user has the same name: ${alike.join(', ')} (check the email domain or alias)`);
    return `${e}: not mapped (${parts.join('; ')})`;
  };

  job.dms = dms.map(d => {
    const notMapped = [], failed = [], reasons = [], called = [], passed = [];
    const destParticipants = [];
    const people = []; // one entry per participant, for the expanded row on the Reports page
    for (const e of d.participants) {
      const sr = src.users.get(e);
      const de = pairOf.source.get(e) || '';
      const dr = de ? dst.users.get(de) : null;
      if (de) destParticipants.push(de);
      if (!sr) {
        const reason = whyUnmapped(e);
        notMapped.push(e); failed.push(e);
        reasons.push(reason);
        people.push({ email: e, dest: '', ok: false, mapped: false, reason: reason.slice(e.length + 2) });
        continue;
      }
      const why = [];
      if (src.required && !sr.authenticated) why.push(`source ${typeName(src.type)}: ${sr.reason}`);
      if (dst.required && !de) why.push(`no destination user in the mapping`);
      else if (dst.required && !dr?.authenticated) why.push(`destination ${typeName(dst.type)} user ${de}: ${dr?.reason || 'not found'}`);
      if (why.length) { failed.push(e); reasons.push(`${e}: ${why.join('; ')}`); } else passed.push(e);
      people.push({ email: e, dest: de, ok: !why.length, mapped: true, reason: why.join('; ') });
      const checks = apiSides.map(x => (x.role === 'source' ? sr : dr));
      if (checks.length && checks.every(r => r?.apiCalled)) called.push(e);
    }
    const ok = d.participants.length > 0 && failed.length === 0;
    const notAuthed = failed.length - notMapped.length;
    const whyNot = ok ? '' : !d.participants.length ? 'No participant emails in EmailPairs / EmailIds'
      : [notMapped.length && `${notMapped.length} participant${notMapped.length === 1 ? '' : 's'} not mapped`,
        notAuthed && `${notAuthed} participant${notAuthed === 1 ? '' : 's'} not authenticated`].filter(Boolean).join(', ');
    return {
      dmId: d.dmId,
      channelName: d.channelName,
      fromRootId: d.fromRootId,
      type: d.type,
      emailPairsRaw: raw(d.emailPairs),
      participants: d.participants,
      destParticipants,
      participantCount: d.participants.length,
      allMapped: notMapped.length === 0 ? 'Yes' : 'No',
      notMappedEmails: notMapped,
      apiCallHit: !apiSides.length ? 'N/A' : !d.participants.length ? 'No'
        : called.length === d.participants.length ? 'Yes' : called.length ? 'Partial' : 'No',
      apiCalledEmails: called,
      allReady: ok,
      authenticated: ok ? 'Yes' : 'No',
      whyNot,
      authenticatedEmails: passed,
      authenticatedCount: `${passed.length} of ${d.participants.length}`,
      notAuthenticatedEmails: failed,
      notAuthenticatedReason: reasons,
      people,
    };
  });
  s.status = 'done';
  const unmappedCount = new Map();
  for (const d of job.dms) for (const e of d.notMappedEmails) unmappedCount.set(e, (unmappedCount.get(e) || 0) + 1);
  const topUnmapped = [...unmappedCount].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, n]) => `${e} (${n} DMs)`);
  s.note = `${job.dms.filter(d => d.allReady).length} of ${job.dms.length} DMs ready. `
    + `${unmappedCount.size} participant email${unmappedCount.size === 1 ? '' : 's'} not in the mapping${topUnmapped.length ? `, most often: ${topUnmapped.join(', ')}` : ''}. `
    + (translatedDest ? `${translatedDest} mapped destination email${translatedDest === 1 ? '' : 's'} found in EmailPairs / EmailIds were matched to their source user. ` : '')
    + (noEmails.length ? `${noEmails.length} DM${noEmails.length === 1 ? ' has' : 's have'} no readable email in EmailPairs / EmailIds (${sample}).` : '');
  Object.assign(job.summary, {
    dmSource: source,
    dmExports: source === 'api' ? 0 : (sessionIds || []).length,
    dmsTotal: job.dms.length,
    dmsAllMapped: job.dms.filter(d => d.allMapped === 'Yes').length,
    dmsReady: job.dms.filter(d => d.allReady).length,
    apiChecked: apiSides.length > 0,
  });
}

/** Rebuilds the DM list of a finished check for another DM source (no new authentication check). */
async function runDmList(baseCtx, job, source, sessionIds) {
  const ctx = { ...baseCtx, dbId: job.params.dbId };
  job.status = 'running';
  job.dmError = null;
  job.steps = job.steps.filter(x => x.key !== 'dms' && x.key !== 'participants');
  try {
    await buildDmList(ctx, job, source, sessionIds);
  } catch (e) {
    const running = job.steps.find(x => x.status === 'running');
    console.error(`DM list ${job.id} (${source}) failed (step "${running?.label || '?'}"):`, e.stack || e);
    if (running) { running.status = 'failed'; running.note = e.message; }
    job.dms = [];
    job.dmError = e.status === 401 ? 'Metabase session expired. Sign in again and rerun.' : e.message;
    Object.assign(job.summary, { dmSource: source, dmExports: (sessionIds || []).length, dmsTotal: 0, dmsAllMapped: 0, dmsReady: 0 });
  }
  job.status = 'done';
}

/**
 * JSON approach (Export channel info), Slack source only:
 * 1. MessageWorkSpace entries of the chosen DMTODM exports (by SessionId): one DM each, EmailPairs = destination emails
 * 2. PermissionCache: each destination email (DestCloudDetails.EmailId) → its source user (SourceCloudDetails.EmailId)
 * 3. Source users: Clouds (selected user, source admin cloud), cloudStatus/billingStatus gate, then Slack auth.test
 * 4. Old code with a Teams destination: the destination user must also be provisioned (ProvisionStatus);
 *    new code skips that check
 * 5. A DM is ready when every participant is mapped and passes those checks
 */
async function runJsonReport(baseCtx, job) {
  const { dbId, adminUserId, sourceAdminCloudId, destAdminCloudId, destType, sessionIds } = job.params;
  const codeVersion = job.params.codeVersion === 'new' ? 'new' : 'old';
  const ctx = { ...baseCtx, dbId };
  const teamsDestChecked = codeVersion === 'old' && String(destType).toUpperCase() === 'MICROSOFT_TEAMS';
  try {
    // 1. DM workspaces of the selected exports
    // With an uploaded CSV: only the workspaces that involve an uploaded user (by destination or source email)
    const csv = Array.isArray(job.params.mapping) ? job.params.mapping : null;
    let s = step(job, 'workspaces', csv ? 'Read MessageWorkSpace entries of the selected exports for the uploaded users'
      : 'Read MessageWorkSpace entries of the selected exports');
    const allWss = await q.findMessageWorkspaces(ctx.token, dbId, adminUserId, sessionIds);
    const csvAny = csv && new Set(csv.flatMap(r => [r.sourceEmail, r.destEmail]).filter(Boolean));
    const wss = csv ? allWss.filter(ws => extractEmails(ws.emailPairs).some(e => csvAny.has(e))) : allWss;
    s.status = 'done'; s.total = s.done = wss.length;
    s.note = `${wss.length} DM workspace${wss.length === 1 ? '' : 's'} from ${sessionIds.length} export${sessionIds.length === 1 ? '' : 's'}`
      + (csv ? ` (of ${allWss.length}; only those involving the ${csv.length} uploaded users)` : '');

    // 2. EmailPairs (destination emails) → source users: the CSV rows first (when uploaded), then PermissionCache
    //    (which also covers the other participants of the uploaded users' DMs)
    s = step(job, 'mapping', `Match EmailPairs to ${csv ? 'the uploaded CSV and ' : ''}PermissionCache (DestCloudDetails → SourceCloudDetails)`);
    const pc = await q.findPermissionCache(ctx.token, dbId, sourceAdminCloudId, destAdminCloudId).catch(e => { if (csv) return []; throw e; });
    const mapped = csv ? [...csv, ...pc] : pc;
    const byDest = new Map(), bySource = new Map();
    for (const m of mapped) {
      if (m.destEmail && !byDest.has(m.destEmail)) byDest.set(m.destEmail, m);
      if (m.sourceEmail && !bySource.has(m.sourceEmail)) bySource.set(m.sourceEmail, m);
    }
    const unmatched = new Set();
    for (const ws of wss) {
      ws.people = uniq(extractEmails(ws.emailPairs)).map(e => {
        // A destination email normally; a source email is accepted too
        const m = byDest.get(e) || bySource.get(e);
        if (!m) unmatched.add(e);
        return { raw: e, source: m?.sourceEmail || '', dest: m?.destEmail || '' };
      });
    }
    const sourceEmails = uniq(wss.flatMap(ws => ws.people.map(p => p.source)).filter(Boolean));
    const destEmails = uniq(wss.flatMap(ws => ws.people.map(p => p.dest)).filter(Boolean));
    s.status = 'done'; s.total = s.done = sourceEmails.length;
    s.note = `${sourceEmails.length} source users matched; ${unmatched.size} EmailPairs email${unmatched.size === 1 ? '' : 's'} with no PermissionCache row`;

    // 3. Source users: Clouds status gate + Slack token
    s = step(job, 'slack-source', 'Check Clouds status and Slack tokens of source users (auth.test)');
    const srcSide = {
      role: 'json-source', emails: sourceEmails, adminCloudId: sourceAdminCloudId,
      opts: { userId: adminUserId, statusGate: true },
    };
    const tokens = await tokensWithCache(ctx, job, srcSide, s);
    s.status = 'done';
    const srcUsers = new Map();
    for (const e of sourceEmails) {
      const t = tokens.get(e) || { tokenCheck: 'Not checked' };
      srcUsers.set(e, { email: e, ...t, ...decide(t, { required: true, useApi: true }) });
    }

    // 4. Teams destination (old code only): ProvisionStatus under the destination admin cloud
    let dstUsers = new Map();
    if (teamsDestChecked) {
      s = step(job, 'provision', 'Check ProvisionStatus of Teams destination users (old code)');
      dstUsers = await checkProvisioning(ctx, destEmails, destAdminCloudId, 'destination');
      for (const r of dstUsers.values()) Object.assign(r, decide(r, { required: true, useApi: false }));
      s.status = 'done'; s.total = s.done = dstUsers.size;
      s.note = `${[...dstUsers.values()].filter(r => r.authenticated).length} of ${dstUsers.size} provisioned`;
    }

    // Users report: one row per matched mapping, plus EmailPairs emails with no mapping
    const seen = new Set();
    job.pairs = [];
    const pairRow = (p) => {
      const sr = srcUsers.get(p.source), dr = dstUsers.get(p.dest);
      const why = [];
      if (!p.source) why.push('No PermissionCache row with this DestCloudDetails.EmailId');
      if (sr && !sr.authenticated) why.push(`Source Slack: ${sr.reason}`);
      if (teamsDestChecked && p.dest && dr && !dr.authenticated) why.push(`Destination Microsoft Teams: ${dr.reason}`);
      return {
        sourceEmail: p.source, destEmail: p.dest || (p.source ? '' : p.raw),
        sourceCloud: sr ? 'SLACK' : '', sourceCloudStatus: sr?.cloudStatus || '', sourceBillingStatus: sr?.billingStatus || '',
        sourceTokenCheck: sr?.tokenCheck || '', sourceStatus: sr?.status || '',
        destCloud: dr?.cloudName || '', destProvisioned: !dr ? '' : dr.inProvisionStatus ? (dr.provisioned ? 'Yes' : 'No') : 'Not found',
        destEmailSent: !dr ? '' : dr.inProvisionStatus ? (dr.emailSent ? 'Yes' : 'No') : 'Not found',
        destStatus: teamsDestChecked ? (dr?.status || '') : 'Not required',
        ready: why.length ? 'No' : 'Yes', reason: why.join('; '),
      };
    };
    for (const ws of wss) {
      for (const p of ws.people) {
        const k = p.source ? `${p.source}|${p.dest}` : `?|${p.raw}`;
        if (seen.has(k)) continue;
        seen.add(k);
        job.pairs.push(pairRow(p));
      }
    }
    job.users = [...srcUsers.values(), ...dstUsers.values()];

    // 5. DMs
    s = step(job, 'participants', 'Check each DM: every participant mapped and authenticated');
    job.dms = wss.map(ws => {
      const people = ws.people.map(p => {
        const sr = srcUsers.get(p.source), dr = dstUsers.get(p.dest);
        if (!p.source) return { email: p.raw, dest: p.raw, ok: false, mapped: false, reason: 'not mapped (no PermissionCache row with this DestCloudDetails.EmailId)' };
        const why = [];
        if (!sr?.authenticated) why.push(`source Slack: ${sr?.reason || 'not checked'}`);
        if (teamsDestChecked && !dr?.authenticated) why.push(`destination Microsoft Teams user ${p.dest || '(none)'}: ${dr?.reason || 'not found'}`);
        return { email: p.source, dest: p.dest, ok: !why.length, mapped: true, reason: why.join('; ') };
      });
      const passed = people.filter(x => x.ok), notMapped = people.filter(x => !x.mapped);
      const notAuthed = people.length - passed.length - notMapped.length;
      const ok = people.length > 0 && passed.length === people.length;
      return {
        dmId: ws.id,
        channelName: ws.channelName,
        fromRootId: ws.sessionId,
        type: ws.processStatus,
        emailPairsRaw: JSON.stringify(ws.emailPairs ?? ''),
        participants: people.map(x => x.email),
        destParticipants: people.map(x => x.dest).filter(Boolean),
        participantCount: people.length,
        allMapped: notMapped.length ? 'No' : 'Yes',
        notMappedEmails: notMapped.map(x => x.email),
        apiCallHit: 'N/A',
        allReady: ok,
        authenticated: ok ? 'Yes' : 'No',
        whyNot: ok ? '' : !people.length ? 'No participant emails in EmailPairs'
          : [notMapped.length && `${notMapped.length} participant${notMapped.length === 1 ? '' : 's'} not mapped`,
            notAuthed && `${notAuthed} participant${notAuthed === 1 ? '' : 's'} not authenticated`].filter(Boolean).join(', '),
        authenticatedEmails: passed.map(x => x.email),
        authenticatedCount: `${passed.length} of ${people.length}`,
        notAuthenticatedEmails: people.filter(x => !x.ok).map(x => x.email),
        notAuthenticatedReason: people.filter(x => !x.ok).map(x => `${x.email}: ${x.reason}`),
        people,
      };
    });
    s.status = 'done'; s.total = s.done = job.dms.length;
    s.note = `${job.dms.filter(d => d.allReady).length} of ${job.dms.length} DMs authenticated`;

    const src = [...srcUsers.values()];
    job.summary = {
      mode: 'json', codeVersion, exports: sessionIds.length,
      sides: [
        { role: 'source', type: 'SLACK', required: true, useApi: true, users: src.length,
          authenticated: src.filter(r => r.status === 'Authenticated').length, tokensInvalid: src.filter(r => r.apiCalled && !r.tokenValid).length },
        { role: 'destination', type: destType, required: teamsDestChecked, useApi: false, users: destEmails.length,
          authenticated: [...dstUsers.values()].filter(r => r.status === 'Authenticated').length, tokensInvalid: 0 },
      ],
      pairsTotal: job.pairs.length, pairsReady: job.pairs.filter(p => p.ready === 'Yes').length,
      dmsTotal: job.dms.length, dmsReady: job.dms.filter(d => d.allReady).length,
      dmsAllMapped: job.dms.filter(d => d.allMapped === 'Yes').length, apiChecked: true,
    };
    job.status = 'done';
  } catch (e) {
    const running = job.steps.find(x => x.status === 'running');
    console.error(`JSON check ${job.id} failed (step "${running?.label || '?'}"):`, e.stack || e);
    if (running) { running.status = 'failed'; running.note = e.message; }
    job.status = 'failed';
    job.error = e.status === 401 ? 'Metabase session expired. Sign in again and rerun.' : e.message;
  }
}

module.exports = { runReport, runJsonReport, runDmList };
