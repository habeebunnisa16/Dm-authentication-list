// Quick offline checks: `npm test`
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const q = require('../services/queries');
const slack = require('../services/slack');
const realAuthTest = slack.authTest; // later tests replace slack.authTest with stubs
const { checkProvisioning } = require('../services/validator');
const { runReport } = require('../services/pipeline');
const { authRequired } = require('../services/rules');
const { extractEmails, toCsv } = require('./helpers');

async function main() {
  q.findPermissionCacheByEmails = async () => []; // diagnostics lookup; individual tests override it
  // ProvisionStatus: Provisioned = true under the side's AdminCloudId means authenticated
  q.findProvisionStatus = async (token, dbId, emails, adminCloudId) => {
    assert.strictEqual(adminCloudId, 'dst1');
    return new Map([
      ['a@x.com', { provisioned: true, emailSent: true, cloudName: 'MICROSOFT_TEAMS' }],
      ['b@x.com', { provisioned: false, emailSent: false, cloudName: 'MICROSOFT_TEAMS' }],
    ]);
  };
  const m = await checkProvisioning({ token: 't', dbId: 1 }, ['A@x.com', 'b@x.com', 'c@x.com'], 'dst1', 'destination');
  assert.strictEqual(m.get('a@x.com').authenticated, true);
  assert.strictEqual(m.get('a@x.com').cloudName, 'MICROSOFT_TEAMS');
  assert.strictEqual(m.get('a@x.com').role, 'destination');
  assert.strictEqual(m.get('b@x.com').authenticated, false);
  assert.strictEqual(m.get('c@x.com').inProvisionStatus, false);
  assert.strictEqual(m.get('c@x.com').authenticated, false);

  // Slack API is only hit for SLACK clouds
  assert.strictEqual(slack.isSlackCloud('SLACK'), true);
  assert.strictEqual(slack.isSlackCloud(' slack '), true);
  assert.strictEqual(slack.isSlackCloud('MICROSOFT_TEAMS'), false);
  assert.strictEqual(slack.isSlackCloud(''), false);
  const skipped = await slack.authTest('xoxp-fake', 'MICROSOFT_TEAMS');
  assert.ok(skipped.skipped && !skipped.authenticated);

  // Which side needs authentication, for every combination
  const S = 'SLACK', T = 'MICROSOFT_TEAMS', G = 'GOOGLE_CHAT';
  const expect = [
    [S, S, true, true], [S, T, true, false], [S, G, true, false],
    [T, S, false, true], [T, G, false, false], [T, T, false, true],
    [G, S, false, true], [G, T, false, false], [G, G, false, false],
  ];
  for (const [s, d, source, destination] of expect) {
    assert.deepStrictEqual(authRequired(s, d), { source, destination }, `${s} → ${d}`);
  }
  // New code: Teams needs only mapping; Slack sides are still checked
  const expectNew = [
    [S, S, true, true], [S, T, true, false], [S, G, true, false],
    [T, S, false, true], [T, G, false, false], [T, T, false, false],
    [G, S, false, true], [G, T, false, false], [G, G, false, false],
  ];
  for (const [s, d, source, destination] of expectNew) {
    assert.deepStrictEqual(authRequired(s, d, 'new'), { source, destination }, `new code ${s} → ${d}`);
  }

  // Email extraction from different EmailPairs shapes
  assert.deepStrictEqual(extractEmails(['A@x.com', 'b@y.com']), ['a@x.com', 'b@y.com']);
  assert.deepStrictEqual(extractEmails('a@x.com, b@y.com'), ['a@x.com', 'b@y.com']);
  assert.deepStrictEqual(extractEmails('["a@x.com","b@y.com"]'), ['a@x.com', 'b@y.com']);
  assert.deepStrictEqual(extractEmails([{ from: 'a@x.com', to: 'b@y.com' }]), ['a@x.com', 'b@y.com']);

  // CSV escaping
  const csv = toCsv([{ a: 'x,y', b: ['p', 'q'] }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]);
  assert.ok(csv.includes('"x,y"') && csv.includes('p; q'));
  // Formula injection: cells starting with = + - @ are neutralised with an apostrophe
  const evil = toCsv([{ a: '=HYPERLINK("http://x")', b: '@SUM(1)', c: 'ok@x.com' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }]);
  assert.ok(evil.includes(`"'=HYPERLINK(""http://x"")"`) && evil.includes("'@SUM(1)") && evil.includes(',ok@x.com'));

  // DNS rebinding: only listed Host headers are answered ("name" = any port, "name:port" = that port)
  const { allowedHosts } = require('../security');
  const guard = allowedHosts(['localhost:4000', 'DMAuth.example.com']);
  const hostOk = host => {
    let passed = false, status = 200;
    guard({ get: () => host }, { status: s => { status = s; return { json: () => {} }; } }, () => { passed = true; });
    return passed && status === 200;
  };
  assert.ok(hostOk('localhost:4000') && hostOk('dmauth.example.com') && hostOk('dmauth.example.com:443'));
  assert.ok(!hostOk('localhost:5000') && !hostOk('evil.com:4000') && !hostOk('dmauth.example.com.evil.com') && !hostOk(''));

  sessionStoreAndJobs();
  await slackRateLimits();
  await dmReportSlackToSlack();
  await uploadedMapping();
  await teamsToTeamsPairs();
  await teamsToSlackDestEmails();
  await newCodeTeamsToTeams();
  await jsonApproach();
  await oneTimeMigration();
  await exportJsonWithCsv();
  await authOnceDmListsReuse();
  await billingDeactivated();
  console.log('All self-tests passed');
}

/** Session store drops expired and excess sessions (reporting each); the job store stays bounded; the cache is per user. */
function sessionStoreAndJobs() {
  const { PrunedMemoryStore } = require('../sessionStore');
  const removed = [];
  const store = new PrunedMemoryStore({ max: 2, onRemove: sid => removed.push(sid) });
  const sess = ms => ({ cookie: { expires: new Date(Date.now() + ms) }, mbToken: 't' });
  store.set('old', sess(-1000));
  store.get('old', (e, s) => assert.strictEqual(s, null, 'an expired session is not returned'));
  assert.deepStrictEqual(removed, ['old']);
  store.set('a', sess(60000)); store.set('b', sess(60000)); store.set('c', sess(60000));
  assert.deepStrictEqual(removed, ['old', 'a'], 'over max: the least recently saved session is dropped');
  store.get('c', (e, s) => assert.strictEqual(s.mbToken, 't'));
  store.destroy('b');
  assert.deepStrictEqual(removed, ['old', 'a', 'b']);

  const { jobStore, cache } = require('../services/store');
  const prev = process.env.JOBS_PER_SESSION;
  process.env.JOBS_PER_SESSION = '2';
  try {
    const j1 = jobStore.create('sess-x', {}); j1.status = 'done';
    const j2 = jobStore.create('sess-x', {});           // still running: never dropped
    const j3 = jobStore.create('sess-x', {}); j3.status = 'done';
    assert.strictEqual(jobStore.get(j1.id, 'sess-x'), null, 'oldest finished job dropped');
    assert.ok(jobStore.get(j2.id, 'sess-x') && jobStore.get(j3.id, 'sess-x'));
    assert.strictEqual(jobStore.get(j3.id, 'someone-else'), null);
    assert.strictEqual(jobStore.running('sess-x'), 1);
    jobStore.removeOwner('sess-x');
    assert.strictEqual(jobStore.get(j2.id, 'sess-x'), null);
  } finally {
    if (prev === undefined) delete process.env.JOBS_PER_SESSION; else process.env.JOBS_PER_SESSION = prev;
  }

  // Each Metabase user has their own cache: B doesn't see what A's check stored
  const dir = path.join(__dirname, '..', '..', 'data', 'cache');
  const before = new Set(fs.readdirSync(dir));
  try {
    cache.save('ownertest', 's', 'd', new Map([['source|u@x.com', { tokenValid: true }]]), 'a@corp.com');
    assert.ok(cache.load('ownertest', 's', 'd', 'A@corp.com')['source|u@x.com'], 'same user (any case) reads it');
    assert.deepStrictEqual(cache.load('ownertest', 's', 'd', 'b@corp.com'), {});
    assert.deepStrictEqual(cache.load('ownertest', 's', 'd'), {});
    assert.ok(!fs.readdirSync(dir).some(n => n.includes('corp')), 'no email in the file name');
  } finally {
    for (const n of fs.readdirSync(dir)) if (!before.has(n)) fs.rmSync(path.join(dir, n), { force: true });
  }
}

/** auth.test retries rate limits and Slack outages; a limit that never lifts is "not checked", not "invalid". */
async function slackRateLimits() {
  const realFetch = global.fetch;
  const resp = (status, body, headers = {}) => ({ status, headers: { get: h => headers[h.toLowerCase()] ?? null }, json: async () => body });
  let calls = 0;
  try {
    // Rate limited once (Retry-After 0), then fine
    global.fetch = async () => (++calls === 1 ? resp(429, { ok: false, error: 'ratelimited' }, { 'retry-after': '0' }) : resp(200, { ok: true, user_id: 'U1', team: 'T' }));
    let r = await realAuthTest('xoxp-test', 'SLACK');
    assert.strictEqual(r.authenticated, true);
    assert.strictEqual(calls, 2);

    // Rate limited on every attempt: transient, not an invalid token
    calls = 0;
    global.fetch = async () => { calls++; return resp(429, { ok: false, error: 'ratelimited' }, { 'retry-after': '0' }); };
    r = await realAuthTest('xoxp-test', 'SLACK');
    assert.strictEqual(r.transient, true);
    assert.strictEqual(r.error, 'ratelimited');
    assert.strictEqual(calls, 6);

    // A Slack 503 is retried
    calls = 0;
    global.fetch = async () => (++calls === 1 ? resp(503, {}) : resp(200, { ok: true, user_id: 'U2' }));
    r = await realAuthTest('xoxp-test', 'SLACK');
    assert.strictEqual(r.authenticated, true);

    // A revoked token is a real answer: not retried, not transient
    calls = 0;
    global.fetch = async () => { calls++; return resp(200, { ok: false, error: 'token_revoked' }); };
    r = await realAuthTest('xoxp-test', 'SLACK');
    assert.strictEqual(r.authenticated, false);
    assert.ok(!r.transient);
    assert.strictEqual(calls, 1);
  } finally {
    global.fetch = realFetch;
  }
}

/**
 * Slack to Slack DM report: both sides are checked with auth.test.
 * u1 → d1 (both tokens valid), u2 → d2 (destination token revoked), u3 not mapped.
 */
async function dmReportSlackToSlack() {
  const params = {
    dbId: 'selftest', adminUserId: 'admin', sourceType: 'SLACK', destType: 'SLACK',
    sourceAdminCloudId: 'srcAdmin', destAdminCloudId: 'dstAdmin', dmSource: 'api',
  };
  q.findPermissionCache = async () => [
    { sourceEmail: 'u1@s.com', destEmail: 'd1@d.com' },
    { sourceEmail: 'u2@s.com', destEmail: 'd2@d.com' },
  ];
  q.findProvisionStatus = async (token, dbId, emails) => new Map(emails.map(e => [e, { provisioned: true, emailSent: true, cloudName: 'SLACK' }]));
  q.findCloudsByEmails = async (token, dbId, emails) => emails.map(e => ({
    email: e, cloudName: 'SLACK', cloudUserId: `cu-${e}`, adminCloudId: e.endsWith('@s.com') ? 'srcAdmin' : 'dstAdmin',
  }));
  q.findAccessTokens = async (token, dbId, ids) => new Map(ids.map(id => [id, `tok-${id}`]));
  slack.authTest = async accessToken => (accessToken === 'tok-cu-d2@d.com'
    ? { authenticated: false, error: 'token_revoked' }
    : { authenticated: true, slackUserId: 'U1', team: 'T' });
  q.findSlackDms = async (token, dbId, userId, adminCloudId, types) => {
    assert.strictEqual(adminCloudId, 'srcAdmin');
    assert.deepStrictEqual(types, ['im', 'mpim']);
    return [
      { dmId: '1', type: 'im', emailPairs: ['u1@s.com'], emailIds: [] },
      { dmId: '2', type: 'im', emailPairs: ['u1@s.com', 'u2@s.com'], emailIds: [] },
      { dmId: '3', type: 'mpim', emailPairs: 'u1@s.com, u3@s.com', emailIds: [] },
    ];
  };
  const cacheFile = path.join(__dirname, '..', '..', 'data', 'cache', 'selftest__srcAdmin__dstAdmin.json');
  try {
    const job = { params, steps: [], users: [], dms: [] };
    await runReport({ token: 't' }, job);
    assert.strictEqual(job.status, 'done', job.error);
    const dm = id => job.dms.find(d => d.dmId === id);
    assert.strictEqual(dm('1').authenticated, 'Yes');
    assert.strictEqual(dm('2').authenticated, 'No');
    assert.ok(dm('2').notAuthenticatedReason[0].includes('token_revoked'));
    assert.deepStrictEqual(dm('2').authenticatedEmails, ['u1@s.com']);
    assert.strictEqual(dm('2').authenticatedCount, '1 of 2');
    assert.strictEqual(dm('3').authenticated, 'No');
    assert.deepStrictEqual(dm('3').notMappedEmails, ['u3@s.com']);
    assert.strictEqual(dm('3').whyNot, '1 participant not mapped');
    assert.strictEqual(dm('2').whyNot, '1 participant not authenticated');
    assert.ok(dm('2').notAuthenticatedReason[0].startsWith('u2@s.com: destination Slack user d2@d.com: Slack token rejected'));

    // Users report: one row per mapping, ready only when both Slack tokens pass
    assert.strictEqual(job.pairs.length, 2);
    const pair = e => job.pairs.find(x => x.sourceEmail === e);
    assert.strictEqual(pair('u1@s.com').ready, 'Yes');
    assert.strictEqual(pair('u2@s.com').ready, 'No');
    assert.strictEqual(pair('u2@s.com').destProvisioned, 'Yes');
    assert.ok(pair('u2@s.com').reason.startsWith('Destination Slack: Slack token rejected'));
    assert.strictEqual(job.summary.dmsReady, 1);
    const d2 = job.users.find(u => u.role === 'destination' && u.email === 'd2@d.com');
    assert.strictEqual(d2.status, 'Not authenticated');
  } finally {
    fs.rmSync(cacheFile, { force: true });
  }
}

/** An uploaded mapping replaces PermissionCache; everything after it runs the same way. */
async function uploadedMapping() {
  // other@s.com isn't in the CSV but is mapped in PermissionCache, and its destination user isn't provisioned
  q.findPermissionCache = async () => [
    { sourceEmail: 'other@s.com', destEmail: 'other@d.com' },
    { sourceEmail: 'unrelated@s.com', destEmail: 'unrelated@d.com' },
  ];
  q.findProvisionStatus = async (token, dbId, emails) => new Map(emails
    .filter(e => e !== 'other@d.com').map(e => [e, { provisioned: true, emailSent: true, cloudName: 'MICROSOFT_TEAMS' }]));
  q.findSlackDms = async () => [
    { dmId: 'a', type: 'oneOnOne', emailIds: ['csv1@s.com', 'csv2@s.com'] },
    { dmId: 'b', type: 'oneOnOne', emailIds: ['csv1@s.com', 'other@s.com'] },
    { dmId: 'c', type: 'oneOnOne', emailIds: ['csv2@s.com', 'stranger@s.com'] },
    { dmId: 'not-ours', type: 'oneOnOne', emailIds: ['unrelated@s.com', 'other@s.com'] },
  ];
  const job = {
    params: {
      dbId: 'csvtest', adminUserId: 'admin', sourceType: 'MICROSOFT_TEAMS', destType: 'MICROSOFT_TEAMS',
      sourceAdminCloudId: 's', destAdminCloudId: 'd', mappingSource: 'Uploaded CSV', dmSource: 'api',
      mapping: [{ sourceEmail: 'csv1@s.com', destEmail: 'csv1@d.com' }, { sourceEmail: 'csv2@s.com', destEmail: 'csv2@d.com' }],
    },
    steps: [], users: [], pairs: [], dms: [],
  };
  await runReport({ token: 't' }, job);
  assert.strictEqual(job.status, 'done', job.error);
  assert.ok(job.steps[0].label.includes('uploaded CSV'));
  assert.strictEqual(job.pairs.length, 2, 'the users report lists only the CSV rows');
  assert.deepStrictEqual(job.dms.map(d => d.dmId), ['a', 'b', 'c'], 'only DMs involving an uploaded user');
  const dm = id => job.dms.find(d => d.dmId === id);
  assert.strictEqual(dm('a').authenticated, 'Yes');
  // Mapped in PermissionCache but not provisioned: mapped, not ready, reason is provisioning
  assert.strictEqual(dm('b').allMapped, 'Yes');
  assert.strictEqual(dm('b').authenticated, 'No');
  assert.strictEqual(dm('b').whyNot, '1 participant not authenticated');
  assert.ok(dm('b').notAuthenticatedReason[0].includes('destination Microsoft Teams user other@d.com: Not found in ProvisionStatus'));
  // Not in the CSV and not in PermissionCache: not mapped
  assert.strictEqual(dm('c').allMapped, 'No');
  assert.ok(dm('c').notAuthenticatedReason[0].includes('not in the uploaded CSV, and not mapped in PermissionCache'));
}

/**
 * Teams to Teams: only the destination is checked, in ProvisionStatus. EmailPairs holds source → destination
 * pairs, so destination emails must not be reported as unmapped participants.
 */
async function teamsToTeamsPairs() {
  q.findPermissionCache = async () => [
    { sourceEmail: 'a@src.com', destEmail: 'a@dst.com' },
    { sourceEmail: 'b@src.com', destEmail: 'b@dst.com' },
  ];
  // b's destination user isn't provisioned; nobody on the source is (the source isn't checked)
  q.findProvisionStatus = async (token, dbId, emails, adminCloudId) => new Map(emails
    .filter(e => adminCloudId === 'd' && e !== 'b@dst.com').map(e => [e, { provisioned: true, emailSent: true, cloudName: 'MICROSOFT_TEAMS' }]));
  slack.authTest = async () => { throw new Error('Slack must not be called for Teams to Teams'); };
  q.findSlackDms = async () => [
    { dmId: 'ok', type: 'oneOnOne', emailPairs: [{ source: 'a@src.com', dest: 'a@dst.com' }], emailIds: ['a@src.com'] },
    { dmId: 'pair', type: 'oneOnOne', emailPairs: 'a@src.com:a@dst.com, b@src.com:b@dst.com', emailIds: [] },
    { dmId: 'alias', type: 'group', emailPairs: ['a@src.com', 'b@other.com'], emailIds: [] },
    { dmId: 'off', type: 'oneOnOne', emailPairs: ['a@src.com', 'c@src.com'], emailIds: [] },
  ];
  // c@src.com has a PermissionCache row for these clouds, but IsMapped is false
  q.findPermissionCacheByEmails = async () => [
    { sourceEmail: 'c@src.com', destEmail: 'c@dst.com', sourceAdminCloudId: 's', destAdminCloudId: 'd', isMapped: false },
  ];
  const job = {
    params: { dbId: 't2t', adminUserId: 'admin', sourceType: 'MICROSOFT_TEAMS', destType: 'MICROSOFT_TEAMS', sourceAdminCloudId: 's', destAdminCloudId: 'd', dmSource: 'api' },
    steps: [], users: [], pairs: [], dms: [],
  };
  await runReport({ token: 't' }, job);
  assert.strictEqual(job.status, 'done', job.error);
  const dm = id => job.dms.find(d => d.dmId === id);
  assert.strictEqual(dm('ok').authenticated, 'Yes');
  assert.deepStrictEqual(dm('ok').notMappedEmails, []);
  assert.deepStrictEqual(dm('pair').participants, ['a@src.com', 'b@src.com']);
  assert.deepStrictEqual(dm('pair').notMappedEmails, [], 'destination emails in EmailPairs are not "not mapped"');
  assert.strictEqual(dm('pair').whyNot, '1 participant not authenticated');
  assert.ok(dm('pair').notAuthenticatedReason[0].includes('destination Microsoft Teams user b@dst.com: Not found in ProvisionStatus'));
  assert.ok(dm('alias').notAuthenticatedReason[0].includes('same name: b@src.com'));
  assert.strictEqual(dm('off').allMapped, 'No');
  assert.ok(dm('off').notAuthenticatedReason[0].includes('row for these admin clouds but IsMapped is false'));
  q.findPermissionCacheByEmails = async () => [];
  assert.strictEqual(job.users.find(u => u.email === 'a@src.com').status, 'Not required');
  assert.strictEqual(job.users.find(u => u.email === 'a@dst.com').status, 'Authenticated');
}

/**
 * Teams to Slack where the SlackDms rows list the destination (Slack) emails. They stand for their mapped
 * source users; a DM with no readable email is reported, and the check doesn't stop.
 */
async function teamsToSlackDestEmails() {
  q.findPermissionCache = async () => [
    { sourceEmail: 'a@teams.com', destEmail: 'a@slack.com' },
    { sourceEmail: 'b@teams.com', destEmail: 'b@slack.com' },
  ];
  q.findProvisionStatus = async (token, dbId, emails) => new Map(emails.map(e => [e, { provisioned: true, emailSent: true, cloudName: 'X' }]));
  q.findCloudsByEmails = async (token, dbId, emails) => emails.map(e => ({ email: e, cloudName: 'SLACK', cloudUserId: `cu-${e}`, adminCloudId: 'd' }));
  q.findAccessTokens = async (token, dbId, ids) => new Map(ids.map(id => [id, `tok-${id}`]));
  slack.authTest = async tok => (tok === 'tok-cu-b@slack.com' ? { authenticated: false, error: 'token_revoked' } : { authenticated: true });
  q.findSlackDms = async () => [
    { dmId: 'dest', type: 'oneOnOne', emailPairs: ['a@slack.com', 'b@slack.com'], emailIds: [] },
    { dmId: 'ok', type: 'oneOnOne', emailPairs: [], emailIds: ['a@slack.com'] },
    { dmId: 'empty', type: 'group', emailPairs: null, emailIds: ['U123', 'U456'] },
  ];
  const job = {
    params: { dbId: 't2s', adminUserId: 'admin', sourceType: 'MICROSOFT_TEAMS', destType: 'SLACK', sourceAdminCloudId: 's', destAdminCloudId: 'd', dmSource: 'api' },
    steps: [], users: [], pairs: [], dms: [],
  };
  try {
    await runReport({ token: 't' }, job);
  } finally {
    fs.rmSync(path.join(__dirname, '..', '..', 'data', 'cache', 't2s__s__d.json'), { force: true });
  }
  assert.strictEqual(job.status, 'done', job.error);
  const dm = id => job.dms.find(d => d.dmId === id);
  assert.deepStrictEqual(dm('dest').participants, ['a@teams.com', 'b@teams.com'], 'destination emails stand for their source users');
  assert.strictEqual(dm('dest').allMapped, 'Yes');
  assert.ok(dm('dest').notAuthenticatedReason[0].includes('b@slack.com') && dm('dest').notAuthenticatedReason[0].includes('token_revoked'));
  assert.strictEqual(dm('ok').authenticated, 'Yes');
  assert.strictEqual(dm('empty').whyNot, 'No participant emails in EmailPairs / EmailIds');
  assert.ok(job.steps.find(st => st.key === 'participants').note.includes('no readable email'));
}

/** New code, Teams to Teams: no ProvisionStatus check; a mapped user or DM is ready even when not provisioned. */
async function newCodeTeamsToTeams() {
  q.findPermissionCache = async () => [{ sourceEmail: 'a@src.com', destEmail: 'a@dst.com' }];
  q.findProvisionStatus = async () => new Map(); // nobody provisioned
  slack.authTest = async () => { throw new Error('Slack must not be called'); };
  q.findSlackDms = async () => [
    { dmId: 'mapped', type: 'oneOnOne', emailIds: ['a@src.com'] },
    { dmId: 'unmapped', type: 'oneOnOne', emailIds: ['a@src.com', 'x@src.com'] },
  ];
  const job = {
    params: { dbId: 'nc', adminUserId: 'admin', sourceType: 'MICROSOFT_TEAMS', destType: 'MICROSOFT_TEAMS', sourceAdminCloudId: 's', destAdminCloudId: 'd', codeVersion: 'new', dmSource: 'api' },
    steps: [], users: [], pairs: [], dms: [],
  };
  await runReport({ token: 't' }, job);
  assert.strictEqual(job.status, 'done', job.error);
  assert.strictEqual(job.summary.codeVersion, 'new');
  assert.strictEqual(job.pairs[0].ready, 'Yes', 'not provisioned does not block in new code');
  assert.strictEqual(job.pairs[0].destProvisioned, 'Not found', 'ProvisionStatus is still shown');
  assert.strictEqual(job.dms.find(d => d.dmId === 'mapped').authenticated, 'Yes');
  assert.strictEqual(job.dms.find(d => d.dmId === 'unmapped').whyNot, '1 participant not mapped');

  // Same data with old code: the Teams destination must be provisioned
  const old = { params: { ...job.params, codeVersion: 'old' }, steps: [], users: [], pairs: [], dms: [] };
  await runReport({ token: 't' }, old);
  assert.strictEqual(old.pairs[0].ready, 'No');
}

/**
 * JSON approach, Slack → Teams: EmailPairs hold destination emails; PermissionCache maps them to source users;
 * Clouds status gate, then auth.test; old code also needs the Teams destination provisioned.
 */
async function jsonApproach() {
  const { runJsonReport } = require('../services/pipeline');
  q.findMessageWorkspaces = async (token, dbId, userId, sessionIds) => {
    assert.deepStrictEqual(sessionIds, ['sess1']);
    return [
      { id: 'w1', channelName: 'a-b', sessionId: 'sess1', processStatus: 'PROCESSED', emailPairs: ['a@dst.com', 'b@dst.com'] },
      { id: 'w2', channelName: 'a-z', sessionId: 'sess1', processStatus: 'NO_MESSAGE', emailPairs: ['a@dst.com', 'z@dst.com'] },
      { id: 'w3', channelName: 'a-c', sessionId: 'sess1', processStatus: 'PROCESSED', emailPairs: ['a@dst.com', 'c@dst.com'] },
      { id: 'w4', channelName: 'a-d', sessionId: 'sess1', processStatus: 'PROCESSED', emailPairs: ['a@dst.com', 'd@dst.com'] },
    ];
  };
  q.findPermissionCache = async () => ['a', 'b', 'c', 'd'].map(n => ({ sourceEmail: `${n}@src.com`, destEmail: `${n}@dst.com` }));
  const status = { 'c@src.com': ['INACTIVE', 'INACTIVE'], 'd@src.com': ['INACTIVE', 'ACTIVE'] };
  q.findCloudsByEmails = async (token, dbId, emails) => emails.map(e => ({
    email: e, cloudName: 'SLACK', cloudUserId: `cu-${e}`, adminCloudId: 's', userId: 'admin',
    cloudStatus: (status[e] || ['ACTIVE'])[0], billingStatus: (status[e] || [, 'ACTIVE'])[1],
  }));
  q.findAccessTokens = async (token, dbId, ids) => new Map(ids.map(id => [id, `tok-${id}`]));
  const called = [];
  slack.authTest = async tok => { called.push(tok); return tok === 'tok-cu-b@src.com' ? { authenticated: false, error: 'token_revoked' } : { authenticated: true }; };
  // d's Teams destination user isn't provisioned
  q.findProvisionStatus = async (token, dbId, emails) => new Map(emails.filter(e => e !== 'd@dst.com').map(e => [e, { provisioned: true, emailSent: true, cloudName: 'MICROSOFT_TEAMS' }]));

  const run = async codeVersion => {
    const job = {
      params: { dbId: 'json', adminUserId: 'admin', sourceType: 'SLACK', destType: 'MICROSOFT_TEAMS', sourceAdminCloudId: 's', destAdminCloudId: 'd', sessionIds: ['sess1'], codeVersion, mode: 'json' },
      steps: [], users: [], pairs: [], dms: [],
    };
    try { await runJsonReport({ token: 't' }, job); } finally { fs.rmSync(path.join(__dirname, '..', '..', 'data', 'cache', 'json__s__d.json'), { force: true }); }
    assert.strictEqual(job.status, 'done', job.error);
    return job;
  };

  const old = await run('old');
  const dm = (job, id) => job.dms.find(d => d.dmId === id);
  assert.strictEqual(dm(old, 'w1').authenticated, 'No');
  assert.ok(dm(old, 'w1').notAuthenticatedReason[0].includes('token_revoked'));
  assert.strictEqual(dm(old, 'w2').allMapped, 'No', 'z@dst.com has no PermissionCache row');
  assert.ok(dm(old, 'w3').notAuthenticatedReason[0].includes('cloudStatus INACTIVE / billingStatus INACTIVE'));
  assert.ok(!called.includes('tok-cu-c@src.com'), 'INACTIVE / INACTIVE is not sent to Slack');
  assert.ok(called.includes('tok-cu-d@src.com'), 'INACTIVE / ACTIVE is sent to Slack');
  assert.strictEqual(dm(old, 'w4').authenticated, 'No', 'old code: Teams destination must be provisioned');
  assert.ok(dm(old, 'w4').notAuthenticatedReason[0].includes('destination Microsoft Teams user d@dst.com'));
  assert.strictEqual(old.summary.mode, 'json');
  assert.ok(old.pairs.some(p => p.destEmail === 'z@dst.com' && p.ready === 'No'));

  const neu = await run('new');
  assert.strictEqual(dm(neu, 'w4').authenticated, 'Yes', 'new code: Teams destination is not checked');
  assert.ok(!neu.steps.some(st => st.key === 'provision'));
}

/** Export-JSON OneTime-Migration: DMs come from ExportChannelInfo (selected exports), then the usual mapping + auth. */
async function oneTimeMigration() {
  q.findSlackDms = async () => { throw new Error('SlackDms must not be read for OneTime-Migration'); };
  q.findExportChannelInfo = async (token, dbId, userId, sessionIds) => {
    assert.deepStrictEqual(sessionIds, ['sess9']);
    return [
      { dmId: 'x1', channelName: 'a-b', fromRootId: 'D1', type: 'dm', emailPairs: null, emailIds: [['a@src.com', 'b@src.com']] },
      { dmId: 'x2', channelName: 'a-q', fromRootId: 'D2', type: 'dm', emailPairs: 'a@src.com, q@src.com', emailIds: [] },
    ];
  };
  q.findPermissionCache = async () => [{ sourceEmail: 'a@src.com', destEmail: 'a@dst.com' }, { sourceEmail: 'b@src.com', destEmail: 'b@dst.com' }];
  q.findProvisionStatus = async (token, dbId, emails) => new Map(emails.map(e => [e, { provisioned: true, emailSent: true, cloudName: 'X' }]));
  q.findCloudsByEmails = async (token, dbId, emails) => emails.map(e => ({ email: e, cloudName: 'SLACK', cloudUserId: `cu-${e}`, adminCloudId: 's' }));
  q.findAccessTokens = async (token, dbId, ids) => new Map(ids.map(id => [id, `tok-${id}`]));
  slack.authTest = async () => ({ authenticated: true });
  const job = {
    params: { dbId: 'ot', adminUserId: 'admin', sourceType: 'SLACK', destType: 'MICROSOFT_TEAMS', sourceAdminCloudId: 's', destAdminCloudId: 'd', sessionIds: ['sess9'], mode: 'onetime' },
    steps: [], users: [], pairs: [], dms: [],
  };
  try { await runReport({ token: 't' }, job); } finally { fs.rmSync(path.join(__dirname, '..', '..', 'data', 'cache', 'ot__s__d.json'), { force: true }); }
  assert.strictEqual(job.status, 'done', job.error);
  assert.strictEqual(job.summary.mode, 'onetime');
  assert.ok(job.steps.find(st => st.key === 'dms').label.includes('ExportChannelInfo'));
  assert.strictEqual(job.dms.find(d => d.dmId === 'x1').authenticated, 'Yes');
  assert.strictEqual(job.dms.find(d => d.dmId === 'x2').allMapped, 'No', 'q@src.com is not mapped');
}

/** Export-JSON with an uploaded CSV: only DMs involving the uploaded users; their mapping comes from the CSV. */
async function exportJsonWithCsv() {
  const { runJsonReport } = require('../services/pipeline');
  const csv = [{ sourceEmail: 'u@src.com', destEmail: 'u@dst.com' }];
  // PermissionCache maps the other participant v only; u is mapped by the CSV alone
  q.findPermissionCache = async () => [{ sourceEmail: 'v@src.com', destEmail: 'v@dst.com' }];
  q.findProvisionStatus = async (token, dbId, emails) => new Map(emails.map(e => [e, { provisioned: true, emailSent: true, cloudName: 'X' }]));
  q.findCloudsByEmails = async (token, dbId, emails) => emails.map(e => ({ email: e, cloudName: 'SLACK', cloudUserId: `cu-${e}`, adminCloudId: 's', userId: 'admin', cloudStatus: 'ACTIVE', billingStatus: 'ACTIVE' }));
  q.findAccessTokens = async (token, dbId, ids) => new Map(ids.map(id => [id, `tok-${id}`]));
  slack.authTest = async () => ({ authenticated: true });
  const base = { dbId: 'csvx', adminUserId: 'admin', sourceType: 'SLACK', destType: 'MICROSOFT_TEAMS', sourceAdminCloudId: 's', destAdminCloudId: 'd', sessionIds: ['s1'], codeVersion: 'new', mapping: csv, mappingSource: 'Uploaded CSV' };
  const clean = () => fs.rmSync(path.join(__dirname, '..', '..', 'data', 'cache', 'csvx__s__d.json'), { force: true });

  // Delta-validation: workspaces hold destination emails
  q.findMessageWorkspaces = async () => [
    { id: 'mine', channelName: 'u-v', sessionId: 's1', processStatus: 'PROCESSED', emailPairs: ['u@dst.com', 'v@dst.com'] },
    { id: 'other', channelName: 'v-w', sessionId: 's1', processStatus: 'PROCESSED', emailPairs: ['v@dst.com', 'w@dst.com'] },
  ];
  const delta = { params: { ...base, mode: 'json' }, steps: [], users: [], pairs: [], dms: [] };
  try { await runJsonReport({ token: 't' }, delta); } finally { clean(); }
  assert.strictEqual(delta.status, 'done', delta.error);
  assert.deepStrictEqual(delta.dms.map(d => d.dmId), ['mine'], 'Delta: only DMs of the uploaded users');
  assert.strictEqual(delta.dms[0].authenticated, 'Yes', 'u mapped by the CSV, v by PermissionCache');

  // OneTime-Migration: ExportChannelInfo holds source emails
  q.findExportChannelInfo = async () => [
    { dmId: 'mine', channelName: 'u-v', fromRootId: 'D1', type: 'dm', emailPairs: ['u@src.com', 'v@src.com'], emailIds: [] },
    { dmId: 'other', channelName: 'v-w', fromRootId: 'D2', type: 'dm', emailPairs: ['v@src.com', 'w@src.com'], emailIds: [] },
  ];
  q.findSlackDms = async () => { throw new Error('SlackDms must not be read for OneTime-Migration'); };
  const one = { params: { ...base, mode: 'onetime' }, steps: [], users: [], pairs: [], dms: [] };
  try { await runReport({ token: 't' }, one); } finally { clean(); }
  assert.strictEqual(one.status, 'done', one.error);
  assert.deepStrictEqual(one.dms.map(d => d.dmId), ['mine'], 'OneTime: only DMs of the uploaded users');
  assert.strictEqual(one.dms[0].allMapped, 'Yes');
  assert.strictEqual(one.pairs.length, 1, 'the users report lists the CSV rows');
}

/** Users are authenticated once (Auth users list); DM lists from other sources reuse those results. */
async function authOnceDmListsReuse() {
  const { runDmList } = require('../services/pipeline');
  q.findPermissionCache = async () => [
    { sourceEmail: 'a@src.com', destEmail: 'a@dst.com' },
    { sourceEmail: 'b@src.com', destEmail: 'b@dst.com' },
  ];
  let provisionCalls = 0, slackCalls = 0;
  q.findProvisionStatus = async (token, dbId, emails) => { provisionCalls++; return new Map(emails.map(e => [e, { provisioned: true, emailSent: true, cloudName: 'X' }])); };
  q.findCloudsByEmails = async (token, dbId, emails) => emails.map(e => ({ email: e, cloudName: 'SLACK', cloudUserId: `cu-${e}`, adminCloudId: 's' }));
  q.findAccessTokens = async (token, dbId, ids) => new Map(ids.map(id => [id, `tok-${id}`]));
  slack.authTest = async tok => { slackCalls++; return tok === 'tok-cu-b@src.com' ? { authenticated: false, error: 'token_revoked' } : { authenticated: true }; };
  q.findSlackDms = async () => [{ dmId: 'sd', channelName: 'a-b', fromRootId: 'R', type: 'im', emailPairs: ['a@src.com', 'b@src.com'], emailIds: [] }];
  q.findExportChannelInfo = async () => [{ dmId: 'ot', channelName: 'a', fromRootId: 'C', type: 'dm', emailPairs: ['a@src.com'], emailIds: [] }];
  q.findMessageWorkspaces = async () => [{ id: 'mw', channelName: 'a-b', sessionId: 's1', processStatus: 'PROCESSED', emailPairs: ['a@dst.com', 'b@dst.com'] }];

  const job = {
    params: { dbId: 'once', adminUserId: 'admin', sourceType: 'SLACK', destType: 'MICROSOFT_TEAMS', sourceAdminCloudId: 's', destAdminCloudId: 'd', mode: 'api' },
    steps: [], users: [], pairs: [], dms: [],
  };
  const clean = () => fs.rmSync(path.join(__dirname, '..', '..', 'data', 'cache', 'once__s__d.json'), { force: true });
  try {
    await runReport({ token: 't' }, job);
    assert.strictEqual(job.status, 'done', job.error);
    const afterAuth = { provisionCalls, slackCalls };
    assert.strictEqual(job.summary.dmSource, null, 'Auth users list builds no DM list');
    assert.strictEqual(job.dms.length, 0);

    await runDmList({ token: 't' }, job, 'api', []);
    assert.strictEqual(job.summary.dmSource, 'api');
    assert.strictEqual(job.dms[0].dmId, 'sd');

    await runDmList({ token: 't' }, job, 'onetime', ['s1']);
    assert.strictEqual(job.summary.dmSource, 'onetime');
    assert.deepStrictEqual(job.dms.map(d => d.dmId), ['ot']);
    assert.strictEqual(job.dms[0].authenticated, 'Yes');

    await runDmList({ token: 't' }, job, 'delta', ['s1']);
    assert.strictEqual(job.summary.dmSource, 'delta');
    assert.strictEqual(job.dms[0].dmId, 'mw');
    assert.deepStrictEqual(job.dms[0].participants, ['a@src.com', 'b@src.com'], 'destination emails stand for their source users');
    assert.ok(job.dms[0].notAuthenticatedReason[0].includes('token_revoked'), "b's revoked token from the first check is reused");

    assert.deepStrictEqual({ provisionCalls, slackCalls }, afterAuth, 'no new ProvisionStatus or Slack calls for the DM lists');
    assert.strictEqual(job.pairs.length, 2, 'the users report is unchanged');
  } finally { clean(); }

  // One click: check the users, then build the Delta-validation list straight away
  const direct = {
    params: { dbId: 'once', adminUserId: 'admin', sourceType: 'SLACK', destType: 'MICROSOFT_TEAMS', sourceAdminCloudId: 's', destAdminCloudId: 'd', mode: 'api', dmSource: 'delta', sessionIds: ['s1'] },
    steps: [], users: [], pairs: [], dms: [],
  };
  try {
    await runReport({ token: 't' }, direct);
    assert.strictEqual(direct.status, 'done', direct.error);
    assert.strictEqual(direct.summary.dmSource, 'delta');
    assert.strictEqual(direct.dms[0].dmId, 'mw');
    assert.ok(direct.steps.some(st => st.key === 'slack-source'), 'the users were checked in the same run');
  } finally { clean(); }
}

/** billingStatus DEACTIVATED: no auth.test call; ProvisionStatus decides. */
async function billingDeactivated() {
  q.findPermissionCache = async () => [
    { sourceEmail: 'p@src.com', destEmail: 'p@dst.com' }, // deactivated, provisioned
    { sourceEmail: 'n@src.com', destEmail: 'n@dst.com' }, // deactivated, not provisioned
    { sourceEmail: 'a@src.com', destEmail: 'a@dst.com' }, // active: Slack is called
  ];
  q.findProvisionStatus = async (token, dbId, emails) => new Map(emails.filter(e => !e.startsWith('n@')).map(e => [e, { provisioned: true, emailSent: true, cloudName: 'SLACK' }]));
  q.findCloudsByEmails = async (token, dbId, emails) => emails.map(e => ({
    email: e, cloudName: 'SLACK', cloudUserId: `cu-${e}`, adminCloudId: 's', cloudStatus: 'ACTIVE', billingStatus: e.startsWith('a@') ? 'ACTIVE' : 'Deactivated',
  }));
  q.findAccessTokens = async (token, dbId, ids) => new Map(ids.map(id => [id, `tok-${id}`]));
  const called = [];
  slack.authTest = async tok => { called.push(tok); return { authenticated: true }; };
  q.findSlackDms = async () => [{ dmId: 'd', channelName: 'p-a', fromRootId: 'R', type: 'im', emailPairs: ['p@src.com', 'a@src.com'], emailIds: [] }];
  const job = {
    params: { dbId: 'bill', adminUserId: 'admin', sourceType: 'SLACK', destType: 'MICROSOFT_TEAMS', sourceAdminCloudId: 's', destAdminCloudId: 'd', mode: 'api', dmSource: 'api' },
    steps: [], users: [], pairs: [], dms: [],
  };
  try { await runReport({ token: 't' }, job); } finally { fs.rmSync(path.join(__dirname, '..', '..', 'data', 'cache', 'bill__s__d.json'), { force: true }); }
  assert.strictEqual(job.status, 'done', job.error);
  assert.deepStrictEqual(called, ['tok-cu-a@src.com'], 'only the ACTIVE billing user is sent to Slack');
  const u = e => job.users.find(x => x.email === e);
  assert.strictEqual(u('p@src.com').status, 'Authenticated');
  assert.ok(u('p@src.com').reason.includes('DEACTIVATED'));
  assert.strictEqual(u('n@src.com').status, 'Not authenticated');
  assert.strictEqual(job.pairs.find(x => x.sourceEmail === 'p@src.com').sourceBillingStatus, 'DEACTIVATED');
  assert.strictEqual(job.dms[0].authenticated, 'Yes');

  // Cloud and billing status are read for the destination side too (no authentication call there)
  q.findCloudsByEmails = async (token, dbId, emails) => emails.map(e => ({
    email: e, cloudName: e.endsWith('@dst.com') ? 'MICROSOFT_TEAMS' : 'SLACK', cloudUserId: `cu-${e}`,
    adminCloudId: e.endsWith('@dst.com') ? 'd' : 's', cloudStatus: e === 'a@dst.com' ? 'Inactive' : 'ACTIVE', billingStatus: 'ACTIVE',
  }));
  const both = { params: { ...job.params, dbId: 'bill2' }, steps: [], users: [], pairs: [], dms: [] };
  try { await runReport({ token: 't' }, both); } finally { fs.rmSync(path.join(__dirname, '..', '..', 'data', 'cache', 'bill2__s__d.json'), { force: true }); }
  const pa = both.pairs.find(x => x.sourceEmail === 'a@src.com');
  assert.strictEqual(pa.destCloudStatus, 'INACTIVE');
  assert.strictEqual(pa.destBillingStatus, 'ACTIVE');
  assert.strictEqual(pa.sourceCloudStatus, 'ACTIVE');

  // Sign in with Microsoft: claims are checked, nothing else is trusted
  const ms = require('../services/microsoft');
  const TID = '11111111-2222-3333-4444-555555555555';
  Object.assign(process.env, { MS_TENANT_ID: TID, MS_CLIENT_ID: 'cid', MS_CLIENT_SECRET: 'sec', MS_ALLOWED_DOMAIN: 'cloudfuze.com', MS_REDIRECT_URI: '' });
  assert.strictEqual(ms.enabled(), true);
  const claims = (o = {}) => ({
    aud: 'cid', tid: TID, iss: `https://login.microsoftonline.com/${TID}/v2.0`, exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: 'n1', preferred_username: 'Pat.Lee@CloudFuze.com', name: 'Pat Lee', oid: 'o1', ...o,
  });
  assert.deepStrictEqual(ms.checkClaims(claims(), 'n1'), { email: 'pat.lee@cloudfuze.com', name: 'Pat Lee', oid: 'o1' });
  const refused = (c, nonce = 'n1') => { try { ms.checkClaims(c, nonce); } catch (e) { return e.code; } return null; };
  assert.strictEqual(refused(claims({ preferred_username: 'pat@gmail.com' })), 'domain');
  assert.strictEqual(refused(claims({ preferred_username: 'pat@cloudfuze.com.evil.io' })), 'domain');
  assert.strictEqual(refused(claims({ tid: '99999999-2222-3333-4444-555555555555', iss: 'https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0' })), 'domain');
  assert.strictEqual(refused(claims({ aud: 'other' })), 'failed');
  assert.strictEqual(refused(claims({ exp: 1 })), 'expired');
  assert.strictEqual(refused(claims(), 'other-nonce'), 'failed');
  // begin() + complete(): PKCE and state, with Microsoft's token endpoint stubbed
  const { url: msUrl, pending } = ms.begin();
  const sent = new URL(msUrl).searchParams;
  assert.strictEqual(sent.get('state'), pending.state);
  assert.strictEqual(sent.get('code_challenge_method'), 'S256');
  assert.strictEqual(sent.get('redirect_uri'), 'http://localhost:4000/api/auth/microsoft/callback');
  const idToken = c => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.y`;
  const realFetch = global.fetch;
  let tokenReq;
  global.fetch = async (u, o) => { tokenReq = { u, body: o.body.toString() }; return { ok: true, json: async () => ({ id_token: idToken(claims({ nonce: pending.nonce })) }) }; };
  try {
    const who = await ms.complete({ code: 'abc', state: pending.state }, pending);
    assert.strictEqual(who.email, 'pat.lee@cloudfuze.com');
    assert.ok(tokenReq.body.includes('code_verifier=' + pending.verifier) && tokenReq.u.includes(TID));
    const codeOf = p => ms.complete(...p).then(() => null, e => e.code);
    assert.strictEqual(await codeOf([{ code: 'abc', state: 'wrong' }, pending]), 'expired');
    assert.strictEqual(await codeOf([{ code: 'abc', state: pending.state }, undefined]), 'expired');
    assert.strictEqual(await codeOf([{ code: 'abc', state: pending.state }, { ...pending, at: Date.now() - 11 * 60 * 1000 }]), 'expired');
    assert.strictEqual(await codeOf([{ error: 'access_denied', state: pending.state }, pending]), 'denied');
    global.fetch = async () => ({ ok: false, json: async () => ({ error: 'invalid_client' }) });
    assert.strictEqual(await codeOf([{ code: 'abc', state: pending.state }, pending]), 'failed');
  } finally { global.fetch = realFetch; }
  for (const k of ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_ALLOWED_DOMAIN', 'MS_REDIRECT_URI']) delete process.env[k];
  assert.strictEqual(ms.enabled(), false);
}

main().catch(e => { console.error(e); process.exit(1); });
