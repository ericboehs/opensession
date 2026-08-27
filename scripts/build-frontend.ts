/** Build only the web frontend in the current immutable release checkout. */
import { compileAssets } from "../packages/core/opensession-server/src/server/frontend-build";

const meta = await compileAssets();
console.log(`frontend bundle ready: ${meta.entryName}`);
