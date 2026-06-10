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

export function githubUsernameToSlackId(username: string): string | null {
  return GITHUB_TO_SLACK[username] || null;
}

export function linearEmailToGithubUsername(email: string | null): string | null {
  if (!email) return null;
  return LINEAR_EMAIL_TO_GITHUB[email] || null;
}
