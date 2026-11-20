import { appendFileSync } from "node:fs";

const line = { memoryDir: process.env.OE_MEMORY_DIR ?? null, pgliteDir: process.env.OE_PGLITE_DIR ?? null };
appendFileSync(process.env.OE_CHAIN_PROBE_OUT, `${JSON.stringify(line)}\n`);
