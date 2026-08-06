import readSlackChannel from "../agent/tools/read_slack_channel.js";
import readSlackThread from "../agent/tools/read_slack_thread.js";
import type { BindableContext } from "@open-everywhere/core/agent/adapter-api.js";

delete process.env.OE_PLATFORM;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function ctxFor(kind: string): BindableContext {
  return { channel: { kind } };
}

interface DynamicLike {
  readonly kind?: unknown;
  readonly events?: Record<string, ((event: unknown, ctx: BindableContext) => unknown) | undefined>;
}

function isToolEntry(v: unknown): v is { execute: unknown; description: unknown } {
  return typeof v === "object" && v !== null && typeof (v as { execute?: unknown }).execute === "function";
}

const EVENTS = ["session.started"] as const;

const NON_SLACK_KINDS = ["discord", "teams", "linear", "local", "channel:discord", "channel:teams"];


async function assertGate(name: string, def: unknown, descNeedle: string, armedKinds: readonly string[] = ["slack", "channel:slack"], hiddenKinds: readonly string[] = NON_SLACK_KINDS): Promise<void> {
  const d = def as DynamicLike;
  ok(d.kind === "eve:dynamic", `${name} default export is a dynamic (defineDynamic) sentinel`);
  ok(!!d.events, `${name} exposes an events map`);
  ok(typeof d.events?.["turn.started"] !== "function", `${name} does NOT register a turn.started resolver (platform is session-immutable)`);

  for (const ev of EVENTS) {
    const handler = d.events?.[ev];
    ok(typeof handler === "function", `${name} has a ${ev} resolver`);
    if (typeof handler !== "function") return;

    for (const armedKind of armedKinds) {
      const armed = await handler({}, ctxFor(armedKind));
      ok(isToolEntry(armed), `${name}[${ev}] arms the tool on ${armedKind}`);
      if (isToolEntry(armed)) {
        ok(
          typeof armed.description === "string" && (armed.description as string).includes(descNeedle),
          `${name}[${ev}] arms the SAME tool on ${armedKind} (description intact)`,
        );
      }
    }

    for (const kind of hiddenKinds) {
      const hidden = await handler({}, ctxFor(kind));
      ok(hidden === null, `${name}[${ev}] hides the tool on ${kind} (returns null)`);
    }
  }
}

await assertGate("read_slack_channel", readSlackChannel, "Read recent messages from a Slack channel");
await assertGate("read_slack_thread", readSlackThread, "Read all replies in a Slack thread");

console.log(`✓ ${passed} slack-tool-gate assertions passed`);
