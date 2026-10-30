const config = require('../config');
const mb = require('./metabase');
const { resolveNames } = require('./schema');
const { idToString, chunk, uniq } = require('../utils/helpers');

const TRUTHY = [true, 'true', 'TRUE', 'True', 1];

/** Case-insensitive "field is one of these emails" (emails are stored with mixed case). */
function emailIn(field, emails) {
  const lower = uniq(emails.map(e => String(e).trim().toLowerCase()));
  return { $expr: { $in: [{ $toLower: { $ifNull: ['$' + field, ''] } }, lower] } };
}

/** Matches an id whether it is stored as a string or as an ObjectId. */
function idVariants(ids) {
  return uniq(ids.map(String)).flatMap(id => (mb.isHex24(id) ? [id, mb.oid(id)] : [id]));
}

// Step 2: Users → _id (the UserId used in Clouds) by PrimaryEmailId, case-insensitive
async function findUserByEmail(token, dbId, email) {
  const { C, F } = await resolveNames(token, dbId);
  const rows = await mb.runMongo(token, dbId, C.users, [
    { $match: emailIn(F.users.primaryEmail, [email]) },
    { $limit: 5 },
    { $project: { [F.users.id]: 1, [F.users.primaryEmail]: 1 } },
  ]);
  if (!rows.length) return null;
  return { id: idToString(rows[0][F.users.id]), email: rows[0][F.users.primaryEmail], matches: rows.length };
}

// Step 2: every Users document for the user picker (findAll pages past Metabase's 2000-row cap
// and checks the total). Users without a PrimaryEmailId are kept, with email '', so none go missing.
async function listUsers(token, dbId) {
  const { C, F, duplicates } = await resolveNames(token, dbId);
  const f = F.users;
  const rows = await mb.findAll(token, dbId, C.users, {}, { [f.id]: 1, [f.primaryEmail]: 1 });
  const users = rows
    .map(r => ({ id: idToString(r[f.id]), email: String(r[f.primaryEmail] ?? '').trim() }))
    .filter(u => u.id)
    .sort((a, b) => (!a.email - !b.email) || a.email.localeCompare(b.email, undefined, { sensitivity: 'base' }));
  return {
    users,
    total: users.length,
    withoutEmail: users.filter(u => !u.email).length,
    collection: C.users,
    field: f.primaryEmail,
    duplicates: duplicates.users || [], // other collections with the same name, with document counts
  };
}

// Step 2: one user by Users._id (string or ObjectId)
async function findUserById(token, dbId, id) {
  const { C, F } = await resolveNames(token, dbId);
  const rows = await mb.runMongo(token, dbId, C.users, [
    { $match: { [F.users.id]: { $in: idVariants([id]) } } },
    { $limit: 1 },
    { $project: { [F.users.id]: 1, [F.users.primaryEmail]: 1 } },
  ]);
  if (!rows.length) return null;
  return { id: idToString(rows[0][F.users.id]), email: rows[0][F.users.primaryEmail], matches: 1 };
}

// Step 2: Clouds where userId = <Users._id as string> and isAdmin = true
async function findAdminClouds(token, dbId, userIdString) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.clouds;
  const rows = await mb.findAll(token, dbId, C.clouds,
    { [f.userId]: { $in: idVariants([userIdString]) }, [f.isAdmin]: { $in: TRUTHY } },
    { [f.id]: 1, [f.cloudName]: 1, [f.email]: 1, [f.cloudStatus]: 1, [f.billingStatus]: 1 },
    { max: 5000 });
  return rows.map(r => ({
    cloudId: idToString(r[f.id]),
    cloudName: r[f.cloudName] ?? '',
    email: r[f.email] ?? '',
    cloudStatus: r[f.cloudStatus] ?? '',
    billingStatus: r[f.billingStatus] ?? '',
  }));
}

const EMAIL_ONE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads a dotted path (e.g. sourceCloudDetails.emailId) from a document, matching each key
 * case-insensitively. If the last key isn't found, falls back to the first email-looking
 * value inside the parent object.
 */
function pickPath(doc, path) {
  let cur = doc;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (typeof cur === 'string' && cur.trim().startsWith('{')) { try { cur = JSON.parse(cur); } catch { /* keep */ } }
    if (cur == null || typeof cur !== 'object') return undefined;
    const want = parts[i].toLowerCase();
    const k = Object.keys(cur).find(x => x.toLowerCase() === want);
    if (k === undefined) {
      if (i === parts.length - 1 && /mail/i.test(parts[i])) {
        const emailKey = Object.keys(cur).find(x => /^e?mail(id|address)?$/i.test(x));
        if (emailKey) return cur[emailKey];
        return Object.values(cur).find(v => typeof v === 'string' && EMAIL_ONE.test(v.trim()));
      }
      return undefined;
    }
    cur = cur[k];
  }
  return cur;
}

// Steps 3/5: PermissionCache filtered by the combination, IsMapped = true
async function findPermissionCache(token, dbId, sourceAdminCloudId, destAdminCloudId) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.permissionCache;
  const top = p => p.split('.')[0];
  // Project the whole parent object for nested fields and read the child in code, so the
  // child key's capitalisation (emailId / EmailId) doesn't matter.
  const rows = await mb.findAll(token, dbId, C.permissionCache,
    {
      [f.sourceAdminCloudId]: { $in: idVariants([sourceAdminCloudId]) },
      [f.destAdminCloudId]: { $in: idVariants([destAdminCloudId]) },
      [f.isMapped]: { $in: TRUTHY },
    },
    {
      [f.sourceAdminCloudId]: 1, [f.destAdminCloudId]: 1, [f.isMapped]: 1,
      [top(f.sourceEmail)]: 1, [top(f.destEmail)]: 1,
    });
  const str = v => (v == null ? '' : String(v)).trim().toLowerCase();
  return rows.map(r => ({
    sourceAdminCloudId: idToString(pickPath(r, f.sourceAdminCloudId)),
    destAdminCloudId: idToString(pickPath(r, f.destAdminCloudId)),
    isMapped: TRUTHY.includes(pickPath(r, f.isMapped)),
    sourceEmail: str(pickPath(r, f.sourceEmail)),
    destEmail: str(pickPath(r, f.destEmail)),
  }));
}

// Diagnostics: every PermissionCache row for these source emails, whatever the clouds or IsMapped,
// to explain why a DM participant didn't match the mapping.
async function findPermissionCacheByEmails(token, dbId, emails) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.permissionCache;
  const top = p => p.split('.')[0];
  const out = [];
  for (const batch of chunk(uniq(emails), config.lookupBatchSize)) {
    const rows = await mb.findAll(token, dbId, C.permissionCache, emailIn(f.sourceEmail, batch), {
      [f.sourceAdminCloudId]: 1, [f.destAdminCloudId]: 1, [f.isMapped]: 1, [top(f.sourceEmail)]: 1, [top(f.destEmail)]: 1,
    }, { max: 20000 });
    const str = v => (v == null ? '' : String(v)).trim().toLowerCase();
    out.push(...rows.map(r => ({
      sourceAdminCloudId: idToString(pickPath(r, f.sourceAdminCloudId)),
      destAdminCloudId: idToString(pickPath(r, f.destAdminCloudId)),
      isMapped: TRUTHY.includes(pickPath(r, f.isMapped)),
      sourceEmail: str(pickPath(r, f.sourceEmail)),
      destEmail: str(pickPath(r, f.destEmail)),
    })));
  }
  return out;
}

// JSON approach: DMTODM exports of the user that finished (ExportChannelsQueue), newest first
async function findExports(token, dbId, userIdString) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.exportQueue, j = config.jsonApproach;
  const rows = await mb.findAll(token, dbId, C.exportQueue, {
    [f.userId]: { $in: idVariants([userIdString]) },
    [f.exportType]: j.exportType,
    [f.processStatus]: j.exportStatus,
  }, { [f.id]: 1, [f.zipFileName]: 1, [f.sessionId]: 1, [f.createdTime]: 1 }, { max: 20000 });
  const time = v => { const t = new Date(v?.$date ?? v).getTime(); return Number.isNaN(t) ? 0 : t; };
  return rows
    .map(r => ({
      id: idToString(r[f.id]),
      zipFileName: String(r[f.zipFileName] ?? ''),
      sessionId: idToString(r[f.sessionId]),
      createdTime: r[f.createdTime] ?? null,
      createdAt: time(r[f.createdTime]),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// JSON approach: the DM workspaces of the chosen exports (MessageWorkSpace)
async function findMessageWorkspaces(token, dbId, userIdString, sessionIds) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.messageWorkspace, j = config.jsonApproach;
  const FALSY = [false, 'false', 'FALSE', 'False', 0];
  const out = [];
  for (const batch of chunk(uniq(sessionIds.filter(Boolean)), config.lookupBatchSize)) {
    const rows = await mb.findAll(token, dbId, C.messageWorkspace, {
      [f.userId]: { $in: idVariants([userIdString]) },
      [f.sessionId]: { $in: idVariants(batch) },
      [f.directOrGroupMessage]: { $in: TRUTHY },
      [f.deltaMigration]: { $in: FALSY },
      [f.deltaInitiated]: { $in: FALSY },
      [f.processStatus]: { $in: j.workspaceStatuses },
    }, { [f.id]: 1, [f.channelName]: 1, [f.emailPairs]: 1, [f.sessionId]: 1, [f.processStatus]: 1 });
    out.push(...rows.map(r => ({
      id: idToString(r[f.id]),
      channelName: String(r[f.channelName] ?? ''),
      emailPairs: r[f.emailPairs],
      sessionId: idToString(r[f.sessionId]),
      processStatus: String(r[f.processStatus] ?? ''),
    })));
  }
  return out;
}

// Export-JSON, OneTime-Migration: the DMs of the chosen exports (ExportChannelInfo), shaped like findSlackDms
async function findExportChannelInfo(token, dbId, userIdString, sessionIds) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.exportChannelInfo;
  const out = [];
  for (const batch of chunk(uniq(sessionIds.filter(Boolean)), config.lookupBatchSize)) {
    const rows = await mb.findAll(token, dbId, C.exportChannelInfo, {
      [f.userId]: { $in: idVariants([userIdString]) },
      [f.sessionId]: { $in: idVariants(batch) },
      [f.dm]: { $in: TRUTHY },
    }, {
      [f.id]: 1, [f.channelName]: 1, [f.channelId]: 1, [f.sessionId]: 1,
      [f.emailPairs]: 1, [f.emailIds]: 1, [f.members]: 1,
    });
    out.push(...rows.map(r => ({
      dmId: idToString(r[f.id]),
      channelName: String(r[f.channelName] ?? ''),
      fromRootId: idToString(r[f.channelId]) || idToString(r[f.sessionId]),
      type: 'dm',
      emailPairs: r[f.emailPairs],
      emailIds: [r[f.emailIds], r[f.members]].filter(v => v != null),
    })));
  }
  return out;
}

// Step 4: Clouds by email (all clouds for those emails; caller picks the one under the admin cloud)
async function findCloudsByEmails(token, dbId, emails) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.clouds;
  const out = [];
  for (const batch of chunk(uniq(emails), config.lookupBatchSize)) {
    const rows = await mb.findAll(token, dbId, C.clouds, emailIn(f.email, batch), {
      [f.id]: 1, [f.email]: 1, [f.cloudStatus]: 1, [f.billingStatus]: 1,
      [f.adminCloudId]: 1, [f.cloudUserId]: 1, [f.cloudName]: 1, [f.userId]: 1,
    });
    out.push(...rows.map(r => ({
      cloudId: idToString(r[f.id]),
      email: String(r[f.email] || '').trim().toLowerCase(),
      cloudStatus: r[f.cloudStatus] ?? '',
      billingStatus: r[f.billingStatus] ?? '',
      adminCloudId: idToString(r[f.adminCloudId]),
      cloudUserId: idToString(r[f.cloudUserId]),
      userId: idToString(r[f.userId]),
      cloudName: r[f.cloudName] ?? '',
    })));
  }
  return out;
}

// ProvisionStatus rows for these emails under one admin cloud (AdminCloudId).
// Provisioned = true means the user is authenticated.
async function findProvisionStatus(token, dbId, emails, adminCloudId) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.provisionStatus;
  const map = new Map(); // email -> { provisioned, emailSent, cloudName }
  for (const batch of chunk(uniq(emails), config.lookupBatchSize)) {
    const rows = await mb.findAll(token, dbId, C.provisionStatus, {
      $and: [emailIn(f.email, batch), { [f.adminCloudId]: { $in: idVariants([adminCloudId]) } }],
    }, { [f.email]: 1, [f.provisioned]: 1, [f.emailSent]: 1, [f.cloudName]: 1 });
    for (const r of rows) {
      const e = String(r[f.email] || '').trim().toLowerCase();
      const prev = map.get(e) || { provisioned: false, emailSent: false, cloudName: '' };
      map.set(e, {
        provisioned: prev.provisioned || TRUTHY.includes(r[f.provisioned]),
        emailSent: prev.emailSent || TRUTHY.includes(r[f.emailSent]),
        cloudName: prev.cloudName || String(r[f.cloudName] ?? ''),
      });
    }
  }
  return map;
}

// Step 6: CFOAuthCredentials._id = CloudUserId → AccessToken. Tokens stay server-side.
async function findAccessTokens(token, dbId, cloudUserIds) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.oauth;
  const map = new Map();
  for (const batch of chunk(uniq(cloudUserIds.filter(Boolean)), config.lookupBatchSize)) {
    const rows = await mb.findAll(token, dbId, C.oauth,
      { [f.id]: { $in: idVariants(batch) } },
      { [f.id]: 1, [f.accessToken]: 1 });
    for (const r of rows) map.set(idToString(r[f.id]), r[f.accessToken]);
  }
  return map;
}

// Step 8: SlackDMs by admin userId + source admin cloud id, filtered to `types` (null = every type)
async function findSlackDms(token, dbId, userIdString, adminCloudId, types) {
  const { C, F } = await resolveNames(token, dbId);
  const f = F.slackDms;
  const match = {
    [f.userId]: { $in: idVariants([userIdString]) },
    [f.adminCloudId]: { $in: idVariants([adminCloudId]) },
  };
  if (types) match[f.type] = { $in: types };
  const rows = await mb.findAll(token, dbId, C.slackDms, match,
    { [f.channelName]: 1, [f.fromRootId]: 1, [f.emailPairs]: 1, [f.emailIds]: 1, [f.type]: 1 });
  return rows.map(r => ({
    dmId: idToString(r._id),
    channelName: r[f.channelName] ?? '',
    fromRootId: idToString(r[f.fromRootId]),
    type: r[f.type] ?? '',
    emailPairs: r[f.emailPairs],
    emailIds: r[f.emailIds],
  }));
}

module.exports = {
  listUsers, findUserById, findUserByEmail, findAdminClouds, findPermissionCache, findPermissionCacheByEmails,
  findExports, findMessageWorkspaces, findExportChannelInfo,
  findCloudsByEmails, findProvisionStatus, findAccessTokens, findSlackDms,
};
