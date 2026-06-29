/**
 * Consolidated user/email/ID mappings across GitHub, Slack, and Linear.
 */

/** GitHub username → Slack user ID */
export const GITHUB_TO_SLACK: Record<string, string> = {
  happylinks: "UT41L6GCC",       // Michiel Westerbeek
  johnnylinsf: "U0866D7PCCU",    // Johnny Lin
  "9ranty": "USU9S2YRF",         // Grant Shaddick
  thiblahute: "U065GD4757C",     // Thibault Saunier
  jfrolich: "U08EWERLX8D",       // Jaap Frolich
  soutar: "U08CXTV7ML2",         // John Soutar
  kentdebruin: "U08S8B3P83X",    // Kent de Bruin
};

/** Linear email → GitHub username (for PR reviewer assignment) */
export const LINEAR_EMAIL_TO_GITHUB: Record<string, string> = {
  "michiel@tella.tv": "happylinks",
  "grant@tella.tv": "9ranty",
  "johnny@tella.tv": "johnnylinsf",
  "kent@tella.com": "kentdebruin",
  "john@tella.com": "soutar",
  "jaap@tella.com": "jfrolich",
  "louise@tella.com": "louisedesadeleer",
  "tsaunier@igalia.com": "thiblahute",
};

/** Slack user ID → full display name (single source of truth) */
export const SLACK_ID_TO_NAME: Record<string, string> = {
  UT41L6GCC: "Michiel Westerbeek",
  U0866D7PCCU: "Johnny Lin",
  USU9S2YRF: "Grant Shaddick",
  U065GD4757C: "Thibault Saunier",
  U066K2VRDHA: "Andres Gomez",
  U08CXTV7ML2: "John Soutar",
  U08EWERLX8D: "Jaap Frolich",
  U08JGAT5KNK: "Louise de Sadeleer",
  U08S8B3P83X: "Kent de Bruin",
  U0A3CERFC57: "Connor",
  U0A3PB2MJET: "Ankita Kulkarni",
  U0A7T08405R: "Michael",
  U03EACNTLA1: "Linear",
  // Legacy workspace ids
  U01D3KX3ATW: "Johnny",
  U01E8UE6L15: "Louise",
  U084XSXRQNB: "Kent",
  U086HCZURPM: "Grant",
};

export function slackIdToFirstName(id: string): string | null {
  const name = SLACK_ID_TO_NAME[id];
  return name ? name.split(" ")[0] : null;
}

/**
 * Resolve a teammate reference — a Slack user id, a first name / alias, a full
 * name, or a GitHub login — to their Slack id + display name, for the
 * human-in-the-loop asks (src/server/human-asks.ts). Reuses the same identity
 * table as commit attribution so "ask Grant" / "grant" / "9ranty" / a raw U-id
 * all land on the same person. Returns null for unknown references.
 */
export function resolveTeammate(ref?: string | null): { slackId: string; name: string } | null {
  if (!ref) return null;
  const key = ref.trim().replace(/^@/, "");
  if (!key) return null;

  // Raw Slack id.
  if (/^U[A-Z0-9]{6,}$/.test(key)) {
    const name = SLACK_ID_TO_NAME[key];
    return name ? { slackId: key, name } : null;
  }
  // Name / alias / GitHub login → identity → slackId.
  const id = gitIdentityFor(key);
  if (id) {
    const member = TEAM_GIT_IDENTITY.find((p) => p.name === id.name);
    if (member?.slackId) {
      return { slackId: member.slackId, name: SLACK_ID_TO_NAME[member.slackId] || member.name };
    }
  }
  return null;
}

export function githubUsernameToSlackId(username: string): string | null {
  return GITHUB_TO_SLACK[username] || null;
}

export function linearEmailToGithubUsername(email: string | null): string | null {
  if (!email) return null;
  return LINEAR_EMAIL_TO_GITHUB[email] || null;
}

/** A git author/committer identity. */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Ground-truth git identities, mined from tella-fusion commit history: the exact
 * (name, email) each teammate's commits already use, so GitHub attributes commits
 * we author on their behalf to the right account. `noreply` addresses are used
 * where the person commits with one (guarantees linkage regardless of email
 * privacy); otherwise their current/most-recent author email.
 *
 * `aliases` covers the web user-picker first names (UserPicker TEAM) and is matched
 * case-insensitively; `slackId`/`github` let us resolve Slack senders and Linear
 * issue creators to the same identity.
 */
const TEAM_GIT_IDENTITY: Array<
  GitIdentity & { aliases: string[]; slackId?: string; github?: string }
> = [
  { name: "Michiel Westerbeek", email: "happylinks@gmail.com", aliases: ["michiel"], slackId: "UT41L6GCC", github: "happylinks" },
  { name: "Jaap Frolich", email: "jfrolich@gmail.com", aliases: ["jaap"], slackId: "U08EWERLX8D", github: "jfrolich" },
  { name: "Kent de Bruin", email: "52224550+kentdebruin@users.noreply.github.com", aliases: ["kent"], slackId: "U08S8B3P83X", github: "kentdebruin" },
  { name: "Grant Shaddick", email: "grant@tella.com", aliases: ["grant"], slackId: "USU9S2YRF", github: "9ranty" },
  { name: "Johnny Lin", email: "67078496+johnnylinsf@users.noreply.github.com", aliases: ["johnny"], slackId: "U0866D7PCCU", github: "johnnylinsf" },
  { name: "John Soutar", email: "john@tella.com", aliases: ["john"], slackId: "U08CXTV7ML2", github: "soutar" },
  { name: "Louise de Sadeleer", email: "54376811+louisedesadeleer@users.noreply.github.com", aliases: ["louise"], slackId: "U08JGAT5KNK", github: "louisedesadeleer" },
  { name: "Thibault Saunier", email: "tsaunier@igalia.com", aliases: ["thibault"], slackId: "U065GD4757C", github: "thiblahute" },
];

/**
 * Resolve a prompt author — a web user-picker name, a Slack user id, or an email
 * (e.g. a Linear issue creator) — to a git identity for commit attribution.
 * Returns null for unknown/anonymous/bot authors so their commits keep the
 * machine's default git identity rather than being mis-attributed.
 */
export function gitIdentityFor(user?: string | null): GitIdentity | null {
  if (!user) return null;
  // Drop a trailing parenthetical like " (loop)" the queue/loop paths append.
  const key = user.trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!key || key.toLowerCase() === "anonymous") return null;

  const found = ((): (typeof TEAM_GIT_IDENTITY)[number] | undefined => {
    // Slack user id (e.g. "U08S8B3P83X")
    if (/^U[A-Z0-9]{6,}$/.test(key)) {
      const bySlack = TEAM_GIT_IDENTITY.find((p) => p.slackId === key);
      if (bySlack) return bySlack;
      const name = SLACK_ID_TO_NAME[key]?.toLowerCase();
      return name ? TEAM_GIT_IDENTITY.find((p) => p.name.toLowerCase() === name) : undefined;
    }
    // Email — match the git email directly, or map a Linear account email → github.
    if (key.includes("@")) {
      const lower = key.toLowerCase();
      const byEmail = TEAM_GIT_IDENTITY.find((p) => p.email.toLowerCase() === lower);
      if (byEmail) return byEmail;
      const gh = LINEAR_EMAIL_TO_GITHUB[lower];
      return gh ? TEAM_GIT_IDENTITY.find((p) => p.github === gh) : undefined;
    }
    // A GitHub login (e.g. a PR author / label applier), a web-picker name, an
    // alias (first name), or the first token of the full name.
    const lower = key.toLowerCase();
    return TEAM_GIT_IDENTITY.find(
      (p) =>
        p.github?.toLowerCase() === lower ||
        p.name.toLowerCase() === lower ||
        p.aliases.includes(lower) ||
        p.name.toLowerCase().split(" ")[0] === lower
    );
  })();

  return found ? { name: found.name, email: found.email } : null;
}

/**
 * Build the git author/committer env vars for an agent's child process. Setting
 * these on the process attributes every commit it makes during the run, without
 * mutating repo config (so parallel runs in different worktrees never race).
 * Empty when there's no resolved author — the run keeps the default identity.
 */
export function gitIdentityEnv(author?: GitIdentity | null): Record<string, string> {
  if (!author) return {};
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}
