import { registerVercelConnect } from "@open-everywhere/adapters/agent/credentials/vercel-connect.js";
import { registerGitHubMemory } from "@open-everywhere/core/agent/memory/github.js";

registerVercelConnect();

registerGitHubMemory();

const { registerNotionMemory } = await import("@open-everywhere/adapters/agent/notion/memory.js");
registerNotionMemory();

if (
  (process.env.OE_MEMORY_PROVIDER === "postgres" || process.env.OE_OPERATIONAL_PROVIDER === "postgres") &&
  process.env.DATABASE_URL
) {
  const { registerNeon } = await import("@open-everywhere/adapters/agent/postgres/neon.js");
  await registerNeon();
}
