import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAuthorizedCronRequest } from "../../src/cron-auth.js";
import { getPool } from "../../src/db.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isAuthorizedCronRequest(req)) {
    res.status(401).json({});
    return;
  }

  const sqlText = readFileSync(join(process.cwd(), "scripts/prune.sql"), "utf8");
  const pool = getPool();
  try {
    await pool.query(sqlText);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[oe-telemetry] prune failed:", err instanceof Error ? err.message : "unknown error");
    res.status(500).json({ ok: false });
  } finally {
    await pool.end();
  }
}
