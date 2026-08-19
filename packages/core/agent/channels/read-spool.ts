import { hashResultBody } from "../access/loop-breaker.js";
import type { BindableContext } from "../identity/binding.js";
import type { ChannelReadOutput, ReadOutputLine } from "./channel-read.js";

export const SEAT_READ_INLINE_CAP = 12_000;

export const READ_SPOOL_DIR = "reads";

export interface ReadSpool {
  readonly path?: string;
  readonly shown: number;
  readonly total: number;
}

function lineCost(m: ReadOutputLine): number {
  return m.author.length + m.text.length + 4;
}

export function trimToInlineCap(messages: readonly ReadOutputLine[], cap: number = SEAT_READ_INLINE_CAP): { shown: ReadOutputLine[]; clamped: boolean } {
  const shown: ReadOutputLine[] = [];
  let budget = cap;
  for (const m of messages) {
    const cost = lineCost(m);
    if (cost <= budget) {
      shown.push(m);
      budget -= cost;
      continue;
    }
    if (shown.length === 0) {
      const room = Math.max(0, cap - (m.author.length + 4));
      shown.push({ ...m, text: m.text.slice(0, room) });
      return { shown, clamped: true };
    }
    break;
  }
  return { shown, clamped: false };
}

function safeKeySegment(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export function spoolPathFor(kind: "channel" | "thread", channelKey: string, body: string): string {
  return `${READ_SPOOL_DIR}/${kind}-${safeKeySegment(channelKey)}-${hashResultBody(body).replace(":", "-")}.txt`;
}

export function spoolNote(kind: "channel" | "thread", spool: ReadSpool): string {
  const unit = kind === "channel" ? "messages" : "replies";
  const head = `\n\n[oversize: this page held ${spool.total} ${unit} and only the OLDEST ${spool.shown} are shown above.`;
  if (spool.path === undefined) {
    return (
      `${head} The rest could not be written to a file here, so it is not readable anywhere. ` +
      `Call again with a smaller \`limit\` or a narrower target, or delegate a worker to read the rest.]`
    );
  }
  return (
    `${head} The FULL page is written to \`${spool.path}\` in this session's workspace. ` +
    `A worker you delegate shares this workspace and can read that file. ` +
    `Or call again with a smaller \`limit\` to see less of it here.]`
  );
}

interface SandboxCapableContext {
  getSandbox?: () => Promise<{ writeTextFile: (input: { path: string; content: string }) => Promise<unknown> }>;
}

async function writeSpool(ctx: BindableContext, path: string, body: string): Promise<string | undefined> {
  try {
    const getSandbox = (ctx as unknown as SandboxCapableContext).getSandbox;
    if (typeof getSandbox !== "function") return undefined;
    const sandbox = await getSandbox();
    await sandbox.writeTextFile({ path, content: body });
    return path;
  } catch (err) {
    console.log(`[open-everywhere:read-spool] could not spool an oversize read to ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function capReadForInline<T extends ChannelReadOutput>(
  ctx: BindableContext,
  out: T,
  kind: "channel" | "thread",
  channelKey: string,
  renderFull: () => string,
  cap: number = SEAT_READ_INLINE_CAP,
): Promise<T> {
  const { shown, clamped } = trimToInlineCap(out.messages, cap);
  if (!clamped && shown.length === out.messages.length) return out;
  const fullBody = renderFull();
  const path = await writeSpool(ctx, spoolPathFor(kind, channelKey, fullBody), fullBody);
  return { ...out, messages: shown, spool: { ...(path === undefined ? {} : { path }), shown: shown.length, total: out.messages.length } };
}
