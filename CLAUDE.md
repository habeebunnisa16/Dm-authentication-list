# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Express app with a vanilla-JS single-page front end. For any Slack / Teams / Chat source→destination combination and pair of admin clouds, one run checks which PermissionCache-mapped users are authenticated (Authentication page) and which SlackDms have only authenticated participants (SlackDms page). Which side needs authentication is decided by `authRequired()` in `services/rules.js`: a Slack side always, a Teams destination only for Teams→Teams, Chat never. It never talks to MongoDB directly. Every read goes through **Metabase's API**: native Mongo aggregation pipelines are sent to `POST /api/dataset`. Metabase is read-only.

## Commands

All commands run from `backend/` (Node 18+; it uses the global `fetch`, `node --watch` and `crypto.randomUUID`):

```bash
cp .env.example .env   # METABASE_URL, SESSION_SECRET; optional METABASE_API_KEY, CACHE_TTL_MINUTES, SLACK_CONCURRENCY
npm install
npm start              # http://localhost:4000
npm run dev            # restarts on file changes
npm test               # node src/utils/selftest.js: offline assert checks, no framework
```

There's no linter or test framework. `selftest.js` is one script of plain `assert` calls, run in sequence inside `main()`, so it has no way to run a single test. To test new logic, add asserts to that file. It stubs Metabase and Slack by reassigning exports on the modules (for example `q.findProvisionStatus = async () => ...`, `slack.authTest = ...`), including a full `runReport` run. That only works because `validator.js` and `pipeline.js` call these as `q.fn(...)` / `slack.fn(...)`, so keep that style and don't destructure those imports. Anything that touches Metabase or Slack needs a real instance.

## Architecture

**Request flow:** `server.js` (session and static files) → `routes.js` (all `/api/*` endpoints, which map one-to-one to the wizard screens in `public/app.js`) → `services/queries.js` (one function per business query) → `services/metabase.js` (HTTP and Mongo pipeline execution).

**The schema map lives in `src/config.js`, and it's the source of truth for collection and field names.** If the README's field list disagrees with config, config wins (for example, the admin lookup uses `Users.PrimaryEmailId`). Code never hardcodes DB names. It uses the aliases from `config.collections` / `config.fields`.

**Name resolution (`services/schema.js`).** Metabase shows "friendly" names, so `resolveNames(token, dbId)` reads `/api/database/:id/metadata` and turns each configured name into the real one. It matches case- and separator-insensitively. If that fails, it tries the regexes in `config.fallbacks`. Nested fields use dot notation. When several collections share a normalised name (e.g. `Users` and `users`), `pickTable()` counts each once (cached with the schema) and uses the one with the most documents; `resolveNames` also returns these as `duplicates`. Every query function starts with `const { C, F } = await resolveNames(...)` and builds its pipeline from `C.<alias>` / `F.<alias>.<field>`. Follow the same pattern when you add queries. `GET /api/schema/:dbId` is the diagnostics endpoint behind the "Check field names" page.

**Metabase query mechanics (`services/metabase.js`):**
- Use `mb.oid(hex)` in a pipeline where you need an ObjectId. The serializer rewrites it to `ObjectId("...")`, and `runMongo` rejects with a 400 any `oid()` that isn't 24 hex characters. `idVariants()` in queries.js matches ids stored either as strings or as ObjectIds.
- Metabase caps results at 2000 rows. `findAll()` runs a `$count` first, pages by `_id`, falls back to `$skip` paging, removes duplicates, and **throws if the row count doesn't match**. It never returns partial data silently. It also refuses with a 413 when more than `max` rows match (500k by default). Use `findAll` for anything that can go over 2000 rows. `runMongo` is only for small or bounded results.
- Large `$in` lookups are split into chunks of `config.lookupBatchSize`.
- Email matching is case-insensitive through `$expr` + `$toLower` (`emailIn()`).

**Check pipeline (`services/pipeline.js` → `services/validator.js`):** `POST /api/jobs` (the "Check users authentication" button) starts `runReport` in the background, without awaiting it. The client polls `GET /api/jobs/:id`. The steps are:
1. PermissionCache mapped rows → unique source emails and destination emails, plus the source↔destination pairing.
2. `checkProvisioning` for both sides, each under its own `AdminCloudId`.
3. For each side with `useApi` (the side needs authentication and it's Slack): `checkSlackTokens` for **every** mapped user on that side, not only provisioned ones. It goes Clouds lookup (preferring a SLACK cloud under that side's admin cloud) → CFOAuthCredentials token (keyed by `cloudUserId`) → Slack `auth.test` (concurrency set by `SLACK_CONCURRENCY`; retries on 429). `slack.authTest` itself refuses any cloud whose `cloudName` isn't SLACK.
4. `decide()` gives each user a `status` (a Slack user whose cloud has billingStatus DEACTIVATED is never sent to `auth.test`; `checkSlackTokens` flags `billingDeactivated` and ProvisionStatus decides): `Not required` (side doesn't need authentication; counts as authenticated), else a valid token when `useApi`, else `provisioned`.
5. SlackDms for the admin user and source admin cloud, filtered by `config.dmTypes[sourceType]` (`null` = every type). Participants come from `EmailPairs` / `EmailIds` via `extractEmails` (handles arrays, CSV strings, JSON strings and objects). A DM is authenticated when every participant is a mapped source user who passes the source-side rule (if required) and whose **mapped destination user** passes the destination-side rule (if required). Each DM also records `authenticatedEmails` (the participants who pass) for the ✓/✗ marks on the SlackDms page.

**Export-JSON** (Report type on the Permission cache page, Slack source only) has two modes. `mode: onetime` (OneTime-Migration) is `runReport` with the DMs read from ExportChannelInfo (`findExportChannelInfo`: sessionIds, dm = true, userId) instead of SlackDms. **Delta-validation** (`runJsonReport`, `mode: json`): ExportChannelsQueue (`findExports`) → MessageWorkSpace by sessionId (`findMessageWorkspaces`) → PermissionCache dest→source → `checkSlackTokens` with `{ userId, statusGate }` (Clouds status gate from `config.jsonApproach.checkedStatuses`) → old code also checks a Teams destination in ProvisionStatus. It fills the same `job.pairs` / `job.dms` shapes, so the report pages and CSVs are shared.

**Auth once, DM lists after:** `runReport` checks the users and keeps `job.ctx`; it builds a DM list only when `params.dmSource` (or `mode: onetime`) is set, otherwise `summary.dmSource` is null and the UI hides the DM list step until one is requested (sides, user maps, pairing; non-enumerable, never sent to the browser). `buildDmList(ctx, job, source, sessionIds)` builds `job.dms` from one DM source (api = SlackDms, onetime = ExportChannelInfo, delta = MessageWorkSpace) using those users only, with no Slack or ProvisionStatus calls; `POST /api/jobs/:id/dm-list` runs it again for another source via `runDmList` (`job.summary.dmSource` says which list is current). `runJsonReport` (standalone Delta-validation with its own Clouds status gate) is kept but no longer reached from the UI.

`job.users` holds one row per (role, email) with `role` = `source` | `destination`. `job.pairs` holds one row per PermissionCache mapping (source and destination flags side by side, `ready`, `reason`) and backs the Authentication users report via `GET /api/jobs/:id/pairs`. `job.dms` is served by `GET /api/jobs/:id/dms`; each DM has `whyNot` (a summary) and `notAuthenticatedReason` (one line per failing participant). `job.summary.sides` has per-side counts for the Authentication and SlackDms pages.

**State:**
- Sessions are kept in memory by `src/sessionStore.js` (`PrunedMemoryStore`): expired ones are removed, at most `MAX_SESSIONS` are kept, and a removed session closes its Metabase session and drops its jobs. A restart signs everyone out.
- Jobs are stored in memory (`services/store.js`), scoped to the session ID and removed after 6 hours, with at most `JOBS_PER_SESSION` per session and `MAX_STORED_JOBS` in all (oldest finished dropped first). At most 2 run per session and `MAX_RUNNING_CHECKS` across all users. A restart loses them.
- Slack token-check results are cached on disk at `data/cache/<owner hash>__<db>__<src>__<dst>.json` for `CACHE_TTL_MINUTES`, keyed `role|email` because Slack→Slack can have the same email on both sides. The owner is the signed-in Metabase user (`job.params.cacheOwner`; empty, so shared, in API-key mode), so nobody reads results their own Metabase permissions didn't produce. Expired entries are dropped on save, and stale files are deleted at startup and hourly. The Metabase schema cache (`services/schema.js`) is likewise keyed per Metabase session. If you change the validation rules or the result shape, **bump `CACHE_VERSION`** in `store.js` so old entries are ignored.
- The Metabase session token (or the literal `'api-key'` in API-key mode) exists only in `req.session`.

## Invariants

- Access tokens must never end up in results, the cache, logs, API responses or CSVs. `validator.js` reads the token, calls Slack, and discards it. If tokens are encrypted at rest, the decrypt hook goes in the marked spot in `validator.js`.
- Errors carry an HTTP status through `mb.HttpError`. The error handler in `server.js` turns them into `{ error }` JSON. Route handlers are wrapped in `ah()` so rejected promises reach that handler.
- The authentication rule exists once, in `services/rules.js`, per code version: `authRequired(source, dest, codeVersion)`. "old" checks the Teams destination of Teams→Teams; "new" never checks Teams. The version is chosen at sign-in and kept in `req.session.codeVersion` (switch: `POST /api/settings/code-version`); jobs read it from the session, not from the request body. The front end gets the full matrix from `GET /api/cloud-types` (`authRules`) and never re-implements it.
- Security lives in `src/security.js` and `server.js`: strict CSP and other headers on every response (the page must keep having no inline scripts or styles), a Host-header allowlist on every request (`localhost:PORT` plus `ALLOWED_HOSTS`; blocks DNS rebinding, which would otherwise pass the same-origin check), a same-origin check on every non-GET `/api` call (CSRF), in-memory rate limits (general per session once signed in, else per IP; sign-in per account plus a looser per-IP cap; checks per session plus at most 2 running), and `no-store` on API answers. The server binds to `HOST` (default `127.0.0.1`). In API-key mode, `APP_PASSWORD` gates sign-in, and sign-in is refused when `HOST` isn't loopback and `APP_PASSWORD` is empty. `toCsv` neutralises cells starting with `= + - @` (formula injection). Rate limits are in memory, so a restart resets them.
- **Sign in with Microsoft** (optional, `services/microsoft.js`) is a first gate in front of the Metabase sign-in, on only when `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET` are all set. Routes `GET /api/auth/microsoft` and `/callback` run an authorization-code + PKCE flow and check the id_token claims (audience, tenant, issuer, expiry, nonce, `@MS_ALLOWED_DOMAIN`). The result is `req.session.msUser`; `POST /api/auth/login` refuses without it and carries it across `session.regenerate()`. Metabase access is still each person's own login, so permissions and cache owner stay per user. Sign-out ends the whole session, Microsoft included. There is no API-key interplay: the Microsoft gate is separate from `APP_PASSWORD`.
- Slack `auth.test` retries 429 / `ratelimited` (with a pause shared by all workers until Retry-After), 5xx, timeouts and network errors. If those persist the result is `transient`: shown as "Not checked … rerun", never as an invalid token, and never cached. Metabase calls time out after `METABASE_TIMEOUT_MS` and retry 429/502/503/504.
