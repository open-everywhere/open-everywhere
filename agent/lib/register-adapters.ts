import { registerVercelConnect } from "@open-everywhere/adapters/agent/credentials/vercel-connect.js";
import { registerGitHubMemory } from "@open-everywhere/core/agent/memory/github.js";
import { registerNotionMemory } from "@open-everywhere/adapters/agent/notion/memory.js";
import { registerNeon } from "@open-everywhere/adapters/agent/postgres/neon.js";
import { setBlobPutter } from "@open-everywhere/core/agent/blob/hosting.js";
import { vercelBlobPutter } from "@open-everywhere/adapters/agent/blob/hosting.js";
import { loadBundles } from "../access/bundles.js";

registerVercelConnect(loadBundles().flatMap((b) => b.connections ?? []));

registerGitHubMemory();

registerNotionMemory();

if (
  (process.env.OE_MEMORY_PROVIDER === "postgres" || process.env.OE_OPERATIONAL_PROVIDER === "postgres") &&
  process.env.DATABASE_URL
) {
  await registerNeon();
}

setBlobPutter(vercelBlobPutter);
