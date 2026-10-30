/**
 * Which side of each source → destination combination needs its users authenticated.
 * Chosen at sign-in: "old" code or "new" code.
 *
 * Old code: Slack is always checked, on whichever side it is. Teams is checked only as the
 * destination of Teams to Teams (ProvisionStatus). Google Chat never needs authentication.
 *
 *            → Slack   → Teams   → Chat
 *   Slack      both      source    source
 *   Teams      dest      dest      none
 *   Chat       dest      none      none
 *
 * New code: Teams needs no authentication at all, only mapping. Slack sides are still checked.
 *
 *            → Slack   → Teams   → Chat
 *   Slack      both      source    source
 *   Teams      dest      none      none
 *   Chat       dest      none      none
 */
const CODE_VERSIONS = ['old', 'new'];
const codeVersionOf = v => (v === 'new' ? 'new' : 'old');

function authRequired(sourceType, destType, codeVersion = 'old') {
  const s = String(sourceType).toUpperCase(), d = String(destType).toUpperCase();
  const teamsToTeams = codeVersionOf(codeVersion) === 'old' && s === 'MICROSOFT_TEAMS' && d === 'MICROSOFT_TEAMS';
  return {
    source: s === 'SLACK',
    destination: d === 'SLACK' || teamsToTeams,
  };
}

/** The full matrix for one code version, for the UI. */
function authMatrix(types, codeVersion = 'old') {
  const out = {};
  for (const s of types) {
    out[s] = {};
    for (const d of types) out[s][d] = authRequired(s, d, codeVersion);
  }
  return out;
}

module.exports = { authRequired, authMatrix, CODE_VERSIONS, codeVersionOf };
