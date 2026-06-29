import { registerVercelConnect } from "@open-everywhere/adapters/agent/credentials/vercel-connect.js";

registerVercelConnect();

if (
  (process.env.OE_MEMORY_PROVIDER === "postgres" || process.env.OE_OPERATIONAL_PROVIDER === "postgres") &&
  process.env.DATABASE_URL
) {
  const { registerNeon } = await import("@open-everywhere/adapters/agent/postgres/neon.js");
  await registerNeon();
}
