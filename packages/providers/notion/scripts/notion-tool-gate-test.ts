import readNotionPage from "../agent/tools/read_notion_page.js";
import readNotionComments from "../agent/tools/read_notion_comments.js";
import type { BindableContext } from "@open-everywhere/core/agent/adapter-api.js";

delete process.env.OE_PLATFORM;
delete process.env.OE_SOURCE_SCOPED_TOOLS;

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

const ARMED_KINDS = ["notion", "channel:notion"];
const HIDDEN_KINDS = ["slack", "channel:slack", "discord", "teams", "telegram", "linear", "local", "channel:discord"];

async function assertGate(name: string, def: unknown, descNeedle: string): Promise<void> {
  const d = def as DynamicLike;
  ok(d.kind === "eve:dynamic", `${name} default export is a dynamic (defineDynamic) sentinel`);
  ok(!!d.events, `${name} exposes an events map`);
  ok(typeof d.events?.["turn.started"] !== "function", `${name} does NOT register a turn.started resolver (platform is session-immutable)`);

  for (const ev of EVENTS) {
    const handler = d.events?.[ev];
    ok(typeof handler === "function", `${name} has a ${ev} resolver`);
    if (typeof handler !== "function") return;

    for (const armedKind of ARMED_KINDS) {
      const armed = await handler({}, ctxFor(armedKind));
      ok(isToolEntry(armed), `${name}[${ev}] arms the tool on ${armedKind}`);
      if (isToolEntry(armed)) {
        ok(
          typeof armed.description === "string" && (armed.description as string).includes(descNeedle),
          `${name}[${ev}] arms the SAME tool on ${armedKind} (description intact)`,
        );
      }
    }

    for (const kind of HIDDEN_KINDS) {
      const hidden = await handler({}, ctxFor(kind));
      ok(hidden === null, `${name}[${ev}] hides the tool on ${kind} (returns null)`);
    }
  }
}

await assertGate("read_notion_page", readNotionPage, "Read the text of a Notion page");
await assertGate("read_notion_comments", readNotionComments, "Read the comments / inline discussions on a Notion page");

console.log(`✓ ${passed} notion-tool-gate assertions passed`);
