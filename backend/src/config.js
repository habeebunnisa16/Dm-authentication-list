/**
 * SCHEMA MAP — verify every name here against your MongoDB before first run.
 * The left side is what the code uses; the right side is the real name in your DB.
 */
module.exports = {
  collections: {
    users: 'Users',
    clouds: 'Clouds',
    permissionCache: 'PermissionCache',
    oauth: 'CFOAuthCredentials',
    slackDms: 'SlackDms',
    provisionStatus: 'ProvisionStatus',
    // JSON approach (Export channel info)
    exportQueue: 'ExportChannelsQueue',
    messageWorkspace: 'MessageWorkSpace',
    // Export-JSON, OneTime-Migration
    exportChannelInfo: 'ExportChannelInfo',
  },

  fields: {
    users: {
      id: '_id',
      primaryEmail: 'PrimaryEmailId',  // the user's primary email (not the admin cloud email)
    },
    clouds: {
      id: '_id',
      userId: 'userId',             // Users._id as a string
      isAdmin: 'isAdmin',
      email: 'emailId',
      cloudName: 'cloudName',       // e.g. SLACK, MICROSOFT_TEAMS
      cloudStatus: 'cloudStatus',
      billingStatus: 'billingStatus',
      adminCloudId: 'adminCloudId',
      cloudUserId: 'cloudUserId',   // used as CFOAuthCredentials._id
    },
    permissionCache: {
      sourceAdminCloudId: 'sourceAdminCloudId',
      destAdminCloudId: 'destAdminCloudId',
      isMapped: 'isMapped',
      sourceEmail: 'sourceCloudDetails.emailId', // nested field: use dot notation
      destEmail: 'destCloudDetails.emailId',
    },
    oauth: {
      id: '_id',
      accessToken: 'AccessToken',
    },
    provisionStatus: {
      email: 'emailId',
      provisioned: 'provisioned',     // true = user is authenticated
      emailSent: 'emailSent',
      cloudName: 'cloudName',         // SLACK, MICROSOFT_TEAMS, GOOGLE_CHAT
      adminCloudId: 'adminCloudId',   // source or destination admin cloud id
      cloudId: 'cloudId',
    },
    slackDms: {
      userId: 'userId',             // admin's Users._id (string)
      adminCloudId: 'adminCloudId', // source admin cloud id
      type: 'Types',                // im | mpim | group
      channelName: 'ChannelName',
      fromRootId: 'FromRootId',
      emailPairs: 'EmailPairs',
      emailIds: 'EmailIds',
    },
    exportQueue: {
      id: '_id',
      userId: 'userId',               // Users._id of the chosen user
      exportType: 'exportType',       // DMTODM
      processStatus: 'processStatus', // PROCESSED
      createdTime: 'createdTime',
      zipFileName: 'zipFileName',
      sessionId: 'sessionId',         // links the export to its MessageWorkSpace entries
    },
    messageWorkspace: {
      id: '_id',
      userId: 'userId',
      sessionId: 'sessionId',
      directOrGroupMessage: 'directOrGroupMessage', // true
      deltaMigration: 'deltaMigration',             // false
      deltaInitiated: 'deltaInitiated',             // false
      processStatus: 'processStatus',
      channelName: 'channelName',
      emailPairs: 'emailPairs',                     // destination emails of the DM participants
    },
    exportChannelInfo: {
      id: '_id',
      userId: 'userId',
      sessionId: 'sessionId',     // the selected export
      dm: 'dm',                   // true for DMs
      channelName: 'channelName',
      channelId: 'channelId',
      emailPairs: 'emailPairs',   // participant emails (source); any of these three may hold them
      emailIds: 'emailIds',
      members: 'members',
    },
  },

  // JSON approach filters
  jsonApproach: {
    exportType: 'DMTODM',
    exportStatus: 'PROCESSED',
    workspaceStatuses: ['PROCESSED_WITH_SOME_CONFLICTS', 'NO_MESSAGE', 'PROCESSED'],
    // Clouds statuses (cloudStatus | billingStatus) whose token is checked with auth.test
    checkedStatuses: [['ACTIVE', 'ACTIVE'], ['INACTIVE', 'ACTIVE'], ['ACTIVE', 'INACTIVE']],
  },

  // If a configured field name isn't found, the first real field matching one of these
  // patterns (case-insensitive) is used instead. Check the result on the "Check field names" page.
  fallbacks: {
    users: {
      primaryEmail: ['^primary.?e?mail(.?id)?$', '^primary.?mail'],
    },
    clouds: {
      email: ['^e?mail(id|address)?$', 'mail'],
      cloudStatus: ['^cloud.?status$', '^status$'],
      billingStatus: ['billing.?status', 'billing'],
      adminCloudId: ['^admin.?cloud.?id$'],
      cloudUserId: ['^cloud.?user.?id$'],
      cloudName: ['^cloud.?name$', '^cloud.?type$'],
      userId: ['^user.?id$'],
      isAdmin: ['^is.?admin$'],
    },
    provisionStatus: {
      email: ['^e?mail(id|address)?$', 'mail'],
      provisioned: ['^is.?provisioned$', 'provisioned'],
      emailSent: ['^e?mail.?sent$'],
      cloudName: ['^cloud.?name$', '^cloud.?type$'],
      adminCloudId: ['^admin.?cloud.?id$'],
    },
    oauth: {
      accessToken: ['^access.?token$'],
    },
    permissionCache: {
      sourceEmail: ['^source.*e?mail', '^src.*e?mail', 'source.*user.*(name|id)$'],
      destEmail: ['^dest.*e?mail', '^destination.*e?mail', '^dst.*e?mail', 'dest.*user.*(name|id)$'],
    },
    slackDms: {
      type: ['^types?$'],
      emailPairs: ['email.*pair', 'pair.*email'],
      emailIds: ['^email.*ids?$', '^emails$', 'member.*email', 'participant.*email'],
    },
    exportChannelInfo: {
      dm: ['^is.?dm$', '^dms?$', '^direct.?message'],
      channelName: ['^channel.?name$', '^name$'],
      channelId: ['^channel.?id$'],
      emailPairs: ['email.*pair', 'pair.*email'],
      emailIds: ['^email.*ids?$', '^emails$', 'member.*email', 'participant.*email'],
      members: ['^members?$', '^participants?$', '^users?$'],
    },
  },

  // Cloud types offered in the combination picker (matched against clouds.cloudName)
  cloudTypes: [
    { value: 'SLACK', label: 'Slack' },
    { value: 'MICROSOFT_TEAMS', label: 'Microsoft Teams' },
    { value: 'GOOGLE_CHAT', label: 'Google Chat' },
  ],

  // DM types read from the SlackDms collection, by source type. null = no type filter
  // (every row of the source admin cloud). The run log lists the types found, so these can be narrowed.
  dmTypes: {
    SLACK: ['im', 'mpim'],
    MICROSOFT_TEAMS: ['oneOnOne', 'group'],
    GOOGLE_CHAT: ['DIRECT_MESSAGE', 'GROUP_CHAT'],
  },
  pageSize: 2000,        // Metabase returns at most 2000 rows per ad-hoc query
  lookupBatchSize: 200,  // emails / ids per $in query
};
