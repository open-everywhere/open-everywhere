import readNotionPage from "../agent/tools/read_notion_page.js";
import readNotionComments from "../agent/tools/read_notion_comments.js";
import type { BindableContext } from "@open-everywhere/core/agent/adapter-api.js";
import { evaluateDynamic, registerConfig } from "@open-everywhere/core/agent/adapter-api.js";

delete process.env.OE_PLATFORM;

registerConfig({
  loadDomains: () => [],
  loadSilos: () => [],
  loadBundles: () => [],
  loadBindings: () => [],
  domainsForSurface: () => [],
  pluginRegistry: {},
  skillContent: {},
});

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

function workerCtxFor(platform: string): BindableContext {
  return {
    channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_1" },
    session: { id: "sess-child", auth: { current: { attributes: { oe_platform: platform, oe_grain: "standing" } } } },
  } as unknown as BindableContext;
}


function isToolEntry(v: unknown): v is { execute: unknown; description: unknown } {
  return typeof v === "object" && v !== null && typeof (v as { execute?: unknown }).execute === "function";
}

const EVENTS = ["session.started"] as const;

const ARMED_WORKER_PLATFORMS = ["notion"];
const SEAT_KINDS = ["notion", "channel:notion"];
const HIDDEN_KINDS = ["slack", "channel:slack", "discord", "teams", "linear", "local", "channel:discord"];

async function assertGate(name: string, def: unknown, descNeedle: string): Promise<void> {
  ok(typeof def === "object" && def !== null && Symbol.for("eve.dynamic") in def, `${name} default export is a dynamic (defineDynamic) sentinel`);

  for (const ev of EVENTS) {
    const handler = (_event: unknown, ctx: unknown) => evaluateDynamic(def, ctx);

    for (const platform of ARMED_WORKER_PLATFORMS) {
      const armed = await handler({}, workerCtxFor(platform));
      ok(isToolEntry(armed), `${name}[${ev}] arms the tool on a DELEGATED WORKER from a ${platform} conversation`);
      if (isToolEntry(armed)) {
        ok(
          typeof armed.description === "string" && (armed.description as string).includes(descNeedle),
          `${name}[${ev}] arms the SAME tool for that worker (description intact)`,
        );
      }
    }

    for (const kind of SEAT_KINDS) {
      const seat = await handler({}, ctxFor(kind));
      ok(seat === null, `${name}[${ev}] hides the tool from a CONVERSATIONAL ${kind} seat (returns null) — the chat plane speaks generic verbs`);
    }

    for (const kind of HIDDEN_KINDS) {
      const hidden = await handler({}, ctxFor(kind));
      ok(hidden === null, `${name}[${ev}] hides the tool on ${kind} (returns null)`);
      const hiddenWorker = await handler({}, workerCtxFor(kind));
      ok(hiddenWorker === null, `${name}[${ev}] hides the tool from a worker delegated from ${kind} too — the worker grain is not a source`);
    }
  }
}

await assertGate("read_notion_page", readNotionPage, "Read the text of a Notion page");
await assertGate("read_notion_comments", readNotionComments, "Read the comments / inline discussions on a Notion page");

console.log(`✓ ${passed} notion-tool-gate assertions passed`);
