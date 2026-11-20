import { pgliteOperationalDataDir } from "../../../packages/core/agent/operational/pglite-client.js";
import { sqliteOperationalDbPath } from "../../../packages/core/agent/operational/sqlite.js";

(globalThis as unknown as { __oeMemoryDirProbe?: string }).__oeMemoryDirProbe = sqliteOperationalDbPath();
(globalThis as unknown as { __oePgliteDirProbe?: string }).__oePgliteDirProbe = pgliteOperationalDataDir();
