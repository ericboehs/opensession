/**
 * Move the memory store off its old name.
 *
 * The store lived at ~/.michael-memory, from when the agent was called
 * Michael. `memoryDir()` reads the legacy path when the current one is absent,
 * so nothing breaks without this script — but a fallback is a compatibility
 * shim, not a resting state, and every future reader has to know about it.
 * This moves the directory once so the shim stops being load-bearing.
 *
 * Deliberately a move, not a copy: two directories that both look live is the
 * worse failure, because a write lands in one and a read finds the other.
 *
 *   bun scripts/migrate-memory-dir.ts          # dry run
 *   bun scripts/migrate-memory-dir.ts --apply  # move it
 */
import { existsSync, readdirSync, renameSync, statSync } from "fs";
import { MEMORY_DIR, legacyMemoryDir } from "../packages/core/opensession-server/src/agents/slack/memory";

function describe(dir: string): string {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const bytes = files.reduce((n, f) => n + statSync(`${dir}/${f}`).size, 0);
    return `${files.length} scope file(s), ${bytes.toLocaleString()} bytes`;
  } catch {
    return "unreadable";
  }
}

const legacy = legacyMemoryDir();
const hasLegacy = existsSync(legacy);
const hasCurrent = existsSync(MEMORY_DIR);

console.log(`legacy:  ${legacy} — ${hasLegacy ? describe(legacy) : "absent"}`);
console.log(`current: ${MEMORY_DIR} — ${hasCurrent ? describe(MEMORY_DIR) : "absent"}`);

if (!hasLegacy) {
  console.log("\nNothing to migrate.");
  process.exit(0);
}
if (hasCurrent) {
  // Merging two live stores means deciding which copy of a scope file wins,
  // and getting that wrong loses memories silently. A human should look.
  console.error(
    "\nBoth directories exist. Refusing to merge — inspect them and move the " +
      "scope files by hand, then remove the legacy directory.",
  );
  process.exit(1);
}

if (!process.argv.includes("--apply")) {
  console.log("\nDry run. Re-run with --apply to move it.");
  process.exit(0);
}

renameSync(legacy, MEMORY_DIR);
console.log(`\nMoved to ${MEMORY_DIR} — ${describe(MEMORY_DIR)}`);
console.log("Restart the server so any in-memory snapshot picks up the new path.");
