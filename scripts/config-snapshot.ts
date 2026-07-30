import { buildConfigSnapshot } from "./config-snapshot-build.js";

process.stdout.write(JSON.stringify(buildConfigSnapshot(), null, 2) + "\n");
