import { sqliteOperationalDbPath } from "../../../packages/core/agent/operational/sqlite.js";

(globalThis as unknown as { __oeMemoryDirProbe?: string }).__oeMemoryDirProbe = sqliteOperationalDbPath();
