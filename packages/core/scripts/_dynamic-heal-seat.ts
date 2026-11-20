import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatWindowToken, taskWindowId, threadSeatWindowId } from "../agent/channels/window-key.js";
import { evaluateDynamic } from "../agent/access/window-gated.js";
import type { WindowGrain } from "../agent/identity/binding.js";

export type SavedMemos = Record<string, Record<string, unknown>>;

export interface SeatRequest {
  readonly files: readonly string[];
  readonly grain: WindowGrain;
  readonly sessionId: string;
  readonly memos: SavedMemos;
}

export interface SeatResult {
  readonly offered: string[];
  readonly memos: SavedMemos;
}

const TOKENS: Record<WindowGrain, { token: string; stamp?: string }> = {
  standing: { token: `unified:${formatWindowToken({ domain: "payments", windowId: "payments", generation: 2 })}` },
  task: { token: `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.5"), generation: 2 })}`, stamp: "task" },
  thread: { token: `unified:${formatWindowToken({ domain: "payments", windowId: threadSeatWindowId("slack/C1", "1720.5"), generation: 2 })}`, stamp: "thread" },
  native: { token: "cse_native123" },
};

export function seatContext(grain: WindowGrain, sessionId: string, memos: Record<string, unknown>): Record<string, unknown> {
  const { token, stamp } = TOKENS[grain];
  return {
    channel: { kind: "unified", continuationToken: token },
    session: { id: sessionId, auth: { current: { attributes: stamp === undefined ? {} : { oe_grain: stamp } } } },
    turn: null,
    memo: async (key: unknown, fn: () => unknown) => {
      const k = JSON.stringify(key);
      if (!(k in memos)) memos[k] = JSON.parse(JSON.stringify(await fn()));
      return memos[k];
    },
  };
}

export async function offeredSeat(toolsDir: string, request: SeatRequest): Promise<SeatResult> {
  const memos: SavedMemos = JSON.parse(JSON.stringify(request.memos));
  const offered: string[] = [];
  for (const file of request.files) {
    const mod = (await import(join(toolsDir, file))) as { default: unknown };
    memos[file] ??= {};
    const value = await evaluateDynamic(mod.default, seatContext(request.grain, request.sessionId, memos[file]));
    if (value === null || value === undefined) continue;
    if (typeof (value as { execute?: unknown }).execute === "function") offered.push(file.replace(/\.ts$/, ""));
    else offered.push(...Object.keys(value as Record<string, unknown>));
  }
  return { memos, offered: offered.sort() };
}

if (process.argv[2] === "--child") {
  process.env.OE_SQLITE_PATH ??= join(process.env.TMPDIR ?? "/tmp", `oe-heal-${process.pid}.sqlite3`);
  const request = JSON.parse(readFileSync(process.argv[3] as string, "utf8")) as SeatRequest & { toolsDir: string };
  const result = await offeredSeat(request.toolsDir, request);
  process.stdout.write(`SEAT ${JSON.stringify(result)}\n`);
}
