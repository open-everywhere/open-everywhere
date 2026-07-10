import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isBodySizeOk, validateOtlpLogsJson } from "../../src/validate.js";
import { checkIpRateLimit, firstForwardedIp } from "../../src/ip-limit.js";
import { checkAndIncrementInstanceRateLimit } from "../../src/ratelimit.js";
import { isHeartbeatDuplicate, HEARTBEAT_EVENT_NAME } from "../../src/heartbeat.js";
import { insertEvents, type EventRow } from "../../src/store.js";
import { sql } from "../../src/db.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({});
    return;
  }

  const ip = firstForwardedIp(req.headers["x-forwarded-for"]);
  if (!checkIpRateLimit(ip)) {
    res.status(429).json({});
    return;
  }

  const contentLength = Number(req.headers["content-length"] ?? 0);
  const approxBytes = contentLength > 0 ? contentLength : Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
  if (!isBodySizeOk(approxBytes)) {
    res.status(400).json({});
    return;
  }

  const result = validateOtlpLogsJson(req.body);
  if (!result.ok) {
    res.status(400).json({});
    return;
  }

  const { envelope } = result;

  if (envelope.droppedRecords > 0 || envelope.strippedKeys > 0) {
    console.warn(
      `[oe-telemetry] vocabulary filter: dropped ${envelope.droppedRecords} unknown-event record(s), ` +
        `stripped ${envelope.strippedKeys} unknown key(s) — check src/schema.ts is synced with the emitter`,
    );
  }

  const now = Date.now();
  const sqlFn = sql();

  try {
    const withinLimit = await checkAndIncrementInstanceRateLimit(sqlFn, envelope.instanceId, now);
    if (!withinLimit) {
      res.status(429).json({});
      return;
    }

    const rows: EventRow[] = [];
    for (const record of envelope.records) {
      if (record.eventName === HEARTBEAT_EVENT_NAME) {
        const duplicate = await isHeartbeatDuplicate(sqlFn, envelope.instanceId, now);
        if (duplicate) continue;
      }
      rows.push({ instanceId: envelope.instanceId, resource: envelope.resource, record });
    }

    if (rows.length > 0) await insertEvents(sqlFn, rows);
    res.status(200).json({});
  } catch (err) {
    console.error("[oe-telemetry] ingest storage error:", err instanceof Error ? err.message : "unknown error");
    res.status(500).json({});
  }
}
