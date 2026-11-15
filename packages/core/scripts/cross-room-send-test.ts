import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-cross-room-"));
process.env.OE_SQLITE_PATH = join(tmp, "cross-room.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { auditedCrossRoomSend, CROSS_ROOM_SEND_ACTION } = await import("../agent/audit/cross-room-send.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { resolvePartition } = await import("../agent/memory/partition.js");

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

const ORG = deploymentOrg();
const SECRET_TEXT = "the quarterly numbers, private";

function ctxWith(send: (message: unknown, options: unknown) => Promise<unknown>, seen: { rowsAtSend: number }[]): Record<string, unknown> {
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: "U-ME", attributes: { team_id: "T1", channel_id: "D-ME", channel_type: "im" } } } },
    to: (_channel: unknown, _target: unknown) => ({
      send: async (message: unknown, options: unknown) => {
        seen.push({ rowsAtSend: (await readAudit({ org: ORG, action: CROSS_ROOM_SEND_ACTION })).length });
        return send(message, options);
      },
    }),
  };
}

const rows = async () => readAudit({ org: ORG, action: CROSS_ROOM_SEND_ACTION });

try {
  console.log("§1 the row names the source room and the target, before the send");
  {
    const seen: { rowsAtSend: number }[] = [];
    const ctx = ctxWith(async () => ({ sent: true }), seen);
    const result = await auditedCrossRoomSend(ctx, { channel: {}, channelName: "discord", target: { channelId: "C-TARGET", nested: { x: 1 } }, message: SECRET_TEXT });
    ok((result as { sent?: boolean }).sent === true, "§1 the send ran and its result reached the caller");
    const got = await rows();
    ok(got.length === 1, "§1 one channel.cross_room_send row");
    const row = got[0]!;
    const detail = (row.detail ?? {}) as Record<string, unknown>;
    const source = resolvePartition(ctx as never);
    ok(row.platform === "slack" && row.platform === source.platform && row.workspace === source.workspace && row.surface === source.surface, "§1 the row's partition is the SOURCE room, as OE resolves the calling turn");
    ok(detail.sourcePlatform === source.platform && detail.sourceWorkspace === source.workspace && detail.sourceSurface === source.surface, "§1 the detail names the source room too");
    ok(row.principalId === "U-ME", "§1 the row names the calling principal");
    ok(detail.targetChannel === "discord", "§1 the row names the target channel");
    ok(JSON.stringify(detail.target) === JSON.stringify({ channelId: "C-TARGET" }), "§1 the target carries its string ids only");
    ok(!JSON.stringify(row).includes(SECRET_TEXT), "§1 the message text never reaches the row");
    ok(seen.length === 1 && seen[0]!.rowsAtSend === 1, "§1 the row landed BEFORE the send");
  }

  console.log("§2 a send that throws still leaves its row");
  {
    const seen: { rowsAtSend: number }[] = [];
    const ctx = ctxWith(async () => {
      throw new Error("target refused");
    }, seen);
    let threw = "";
    try {
      await auditedCrossRoomSend(ctx, { channel: {}, channelName: "slack", target: { channelId: "C-OTHER" }, message: "x" });
    } catch (err) {
      threw = String(err);
    }
    ok(threw.includes("target refused"), "§2 the send's own error reaches the caller");
    ok((await rows()).length === 2, "§2 the attempt has its row");
  }

  console.log("§3 negative control: no ctx.to, no row");
  {
    let threw = "";
    try {
      await auditedCrossRoomSend({ channel: { kind: "slack" } }, { channel: {}, channelName: "slack", target: { channelId: "C-X" }, message: "x" });
    } catch (err) {
      threw = String(err);
    }
    ok(threw.includes("no ctx.to"), "§3 a context with no `to` (eve 0.71.0) throws");
    ok((await rows()).length === 2, "§3 …and writes no row");
  }
} finally {
  removeTempDir(tmp);
}

console.log(`✓ cross-room-send: ${n} checks`);
