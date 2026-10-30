# DM authentication check

Reports which mapped users are authenticated, and which DMs have only authenticated participants, for Slack, Teams and Google Chat migrations. Data is read from MongoDB through Metabase.

## Run it

**Quick start (shared copy):** install [Node.js](https://nodejs.org) 18 or newer (the LTS version), then:

- **Windows:** double-click `start.bat`
- **Mac / Linux:** run `./start.sh` in a terminal

The browser opens on http://localhost:4000. Sign in with your Metabase email and password.
The packages are included; if `backend/node_modules` is missing, the script installs them (needs internet).
On the first run it creates `backend/.env` from `.env.example` with a random `SESSION_SECRET`.
Close the window (or press Ctrl+C) to stop.

**By hand:**

```bash
cd backend
npm install
npm run setup             # creates .env with a random SESSION_SECRET (skipped if .env exists)
npm test                  # offline logic checks
npm start                 # http://localhost:4000
```

**Sharing it:** send the folder without `backend/.env` (your settings and secret) and without
`backend/data/cache/*.json` (cached check results with customer emails).

## Before the first run: check `backend/src/config.js`

Every collection and field name is mapped in this one file. Confirm each one against your real schema, especially these:

- `Users.PrimaryEmailId`
- `Clouds.cloudName`, `cloudStatus`, `billingStatus`, `adminCloudId` and `cloudUserId`
- `PermissionCache.SourceEmail` (the mapped source user's email)
- `CFOAuthCredentials.AccessToken`
- `SlackDMs.ChannelName`, `EmailPairs` and `EmailIds`

## Flow

| Screen | What happens |
|---|---|
| Home | Signed out: a short About section (what it checks, how users are checked, where the data comes from, the rules table and the steps) and **Connect to Metabase**, which signs in through Metabase's `/api/session`. The session token stays on the server. |
| Database | Lists the Metabase databases. |
| Select PrimaryEmail | Every `Users` document (`_id` and `PrimaryEmailId`) as option buttons with search; the chosen user shows a green tick. If the database has more than one Users collection (for example `Users` and `users`), the one with the most documents is used and the page says so. |
| Combination | Choose the source and destination type: any of Slack, Microsoft Teams and Google Chat, in any direction, including the same type (for example Slack to Slack). Also shows which side each combination checks. |
| Admin clouds | Lists `Clouds` with `userId` = the chosen user's `_id` and `isAdmin = true` as option buttons (admin emails are `Clouds.emailId`); the chosen source and destination show a green tick. They are picked automatically from the combination when a side has only one cloud of that type, or only one active one; same-type combinations are chosen by hand. |
| Permission cache | Shows the mapped source and destination emails from `PermissionCache` (IsMapped = true for these admin clouds) and the rule for this combination. **Authentication users report** runs the background check. **Upload mapping CSV** (columns `SourceEmail`, `DestEmail`; a template is offered) replaces PermissionCache with the uploaded users and shows two buttons: **Authentication users list** and **SlackDms list**. |
| Authentication users | One row per mapping: Source Email, Cloud, EmailSent, Provisioned, then Destination Email, Cloud, EmailSent, Provisioned, then Ready / Not ready with a short reason (click a row for the full reason). Summary cards filter the table; CSV downloads: all, ready, current view. The **SlackDms list** button opens the next page. |
| SlackDms list | The SlackDms entries of these users (source admin cloud): DM name, FromRootId, Ready to initiate, If not why not, Is mapped, No. of users provisioned, Users not provisioned (reason). Click a row to see every participant marked ✓ / ✕ with their mapped destination user and the full reason. CSV downloads: all, ready, not ready, current view. |

## Old code and new code

Chosen on the Connect page before signing in (and switchable from the step menu afterwards). It only changes which side needs authentication:

- **Old code:** the rules below. A Teams destination in Teams to Teams must have `ProvisionStatus.provisioned = true`.
- **New code:** Teams needs no authentication at all, only mapping. Slack sides are still checked with `auth.test`, and ProvisionStatus never makes a user or DM Not ready (it is still shown).

| Source ↓ / Destination → (new code) | Slack | Teams | Chat |
|---|---|---|---|
| **Slack** | Both | Source | Source |
| **Teams** | Destination | None | None |
| **Chat** | Destination | None | None |

Switching resets the current results, so run the reports again after a switch.

## Which side needs authentication (old code)

A Slack side is always checked. A Teams destination is checked only for Teams to Teams. Google Chat is never checked.

| Source ↓ / Destination → | Slack | Teams | Chat |
|---|---|---|---|
| **Slack** | Both | Source | Source |
| **Teams** | Destination | Destination | None |
| **Chat** | Destination | None | None |

The rule lives in `backend/src/services/rules.js`.

## How a user is checked

| Side | Authenticated when |
|---|---|
| Doesn't need authentication | Not required (counts as authenticated) |
| Slack side | The token is valid: `Clouds` → `CFOAuthCredentials` → Slack `auth.test`. A token revoked by a password change fails. |
| Slack side, cloud **billingStatus DEACTIVATED** | No `auth.test` call: `ProvisionStatus.provisioned = true` decides. Shown as "billing deactivated" in the users table. |
| Teams destination (Teams to Teams) | `ProvisionStatus.provisioned = true` |

ProvisionStatus is looked up under each side's own AdminCloudId. Only clouds whose `cloudName` is `SLACK` are ever sent to Slack.

A DM is authenticated when every participant is a mapped source user, and each participant passes the check on every side that needs it. On a destination side, the check uses the participant's mapped destination user. For example, Slack to Slack checks both the source user's token and their mapped destination user's token.

DMs are read from `SlackDms` for the source admin cloud. For a Slack source, only `im` and `mpim` are read; for a Teams source, `oneOnOne` and `group`; for a Chat source, `DIRECT_MESSAGE` and `GROUP_CHAT`. The lists are `dmTypes` in `config.js` (`null` reads every type).

## Reports

Authentication runs **once**: **Get auth users list** on the Permission cache page checks every mapped user (Slack `auth.test`, ProvisionStatus, per the combination rules) and opens the Authentication users page.

On that page, the **Auth users DM list** card builds a DM list from those results, with no new Slack or ProvisionStatus calls. **Fetch DMs from**:

- **API: SlackDms**: DMs from SlackDms for the source admin cloud (built with the users list, so it opens at once). Page: **SlackDms list**.
- **Export-JSON** (Slack source), then pick the exports (finished DMTODM exports in ExportChannelsQueue, newest first) and the **Export-JSON type**:
  - **OneTime-Migration-List**: DMs from **ExportChannelInfo** (`sessionId`, `dm = true`, `userId`). Page: **ExportChannelInfo-Dms-List**. Field names are under `exportChannelInfo` in `config.js`.
  - **Delta-validation**: already initiated DMs from **MessageWorkSpace** (filters below); their `emailPairs` destination emails are matched back to the checked source users. Page: **Delta-Initiate-List**, opened on the ready DMs.

**Auth users DM list** (the second option on the Permission cache page) does both in one go: choose **Fetch DMs from** (and for Export-JSON the type and the exports) first, then **Check users and get DM list** checks the users and opens that DM list. The Authentication users page is still available from it.

Each DM is ready when every participant is mapped and passed the check on every side that needs it. The users table shows each side's cloud name with its **cloud status and billing status** (read from Clouds under that side's admin cloud; anything not ACTIVE is highlighted). The users CSV has, per side, **email, cloud name, cloud status, billing status, auth status** (source, then destination), then Ready and Reason; no admin cloud ids. Every DM list page also shows the **Auth users** table of the same check (with its own filters and CSV downloads) below the DMs.

An **uploaded mapping CSV** applies to every report type. With Export-JSON, only the DMs that involve an uploaded user are checked; the CSV rows are the mapping for those users, and the other participants of their DMs are looked up in PermissionCache.

## Delta-validation (Export-JSON)

For a **Slack source** only. With Report type **Export-JSON** and type **Delta-validation**, the Permission cache page lists the chosen user's finished exports and runs this check on the ones you tick:

1. **ExportChannelsQueue**: `userId` = the chosen user, `exportType = DMTODM`, `processStatus = PROCESSED`, newest first by `createdTime`, shown by `zipFileName`. One or more can be selected; each gives a `sessionId`.
2. **MessageWorkSpace**: `userId`, `sessionId` in the selected exports, `directOrGroupMessage = true`, `deltaMigration = false`, `deltaInitiated = false`, `processStatus` in PROCESSED_WITH_SOME_CONFLICTS, NO_MESSAGE, PROCESSED. Each entry is one DM (`channelName`, `emailPairs`).
3. **PermissionCache** (user + source and destination admin clouds): each `emailPairs` email is matched to `DestCloudDetails.EmailId`, giving the source user `SourceCloudDetails.EmailId`. An email with no row is **not mapped**.
4. **Clouds** (chosen user, source admin cloud): only cloudStatus / billingStatus ACTIVE/ACTIVE, INACTIVE/ACTIVE and ACTIVE/INACTIVE go on; others are not authenticated.
5. **CFOAuthCredentials** (`_id` = `cloudUserId`) → `AccessToken` → Slack `auth.test`: valid = authenticated, revoked = not authenticated.
6. **Old code** with a Teams destination: the destination user must also be provisioned (ProvisionStatus). **New code** skips that.

Results open on the SlackDms list (MessageWorkSpace DMs), filtered to authenticated DMs; the filter can be cleared to see the rest. The Authentication users page lists every matched user with cloud status, billing status and token result. The filters and statuses live in `jsonApproach` in `config.js`.

## Security and rate limits

- **Listens on this machine only** by default (`HOST=127.0.0.1`). Set `HOST=0.0.0.0` only behind an HTTPS reverse proxy, with `COOKIE_SECURE=true`.
- **API-key mode:** with `METABASE_API_KEY`, everyone signs in as the same Metabase user. Set `APP_PASSWORD` so the Connect button asks for a password; the server warns at start if it is reachable from other machines without one.
- **Browser protections:** strict Content-Security-Policy, no framing, no sniffing, no referrer, `no-store` on API answers, and cross-site requests that change state are refused (CSRF).
- **Rate limits:** 10 sign-in attempts per 15 minutes per client, 600 API calls per minute per client, 30 checks per hour and 2 running checks per session. They are kept in memory; restarting the server resets them.
- **Slack rate limits:** calls run `SLACK_CONCURRENCY` at a time. A 429 pauses every call until Slack's Retry-After has passed, then retries (up to 6 attempts); Slack errors and timeouts are retried too. A user Slack keeps rate limiting is shown as "Not checked … rerun", not as an invalid token, and isn't cached.
- **Metabase:** each query times out after `METABASE_TIMEOUT_MS` (default 120 s) and is retried when Metabase is busy (429, 502, 503, 504).
- **CSV downloads:** cells starting with `=`, `+`, `-` or `@` get a leading apostrophe so Excel can't run them as formulas.
- **SESSION_SECRET:** use a long random string; the server warns at start when it is missing or weak.

## Notes

- **Caching.** Metabase is read-only, so Slack token-check results are cached in `backend/data/cache/`. They're reused for `CACHE_TTL_MINUTES`. Access tokens are never cached, logged, sent to the browser, or written to a CSV.
- **SSO-only Metabase.** If your Metabase only allows SSO sign-in, set `METABASE_API_KEY` and the Connect button signs in with it.
- **Encrypted tokens.** If tokens are encrypted at rest, add the decrypt step where marked in `src/services/validator.js`.
- **Large collections.** Metabase returns at most 2000 rows per query, so queries page through results automatically.
- **Jobs.** Running jobs are kept in memory, so a server restart clears them.
