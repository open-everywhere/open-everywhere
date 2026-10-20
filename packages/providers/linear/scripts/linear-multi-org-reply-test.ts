import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { linearPostArm } from "../agent/channels/linear-post-arm.js";
import { _resetLinearMintCache } from "../agent/channels/linear-credentials.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import type { ReplyTarget, ReactTarget, UnifiedWakeOrigin, UnifiedReplyDeps } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SOAK_ORG = "1a000000-0000-4000-8000-000000000002";
const OTHER_ORG = "11111111-2222-3333-4444-555555555555";
const PRIMARY_TOKEN = "primary_static_token";
const SOAK_MINTED = "soak_minted_token";

const SAVED: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in SAVED)) SAVED[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
setEnv("LINEAR_AGENT_ACCESS_TOKEN", PRIMARY_TOKEN);
setEnv("LINEAR_ACCESS_TOKEN", undefined);
setEnv("LINEAR_API_KEY", undefined);
setEnv("LINEAR_API_TOKEN", undefined);
overrideSettingsForTest({ linear: { organizationId: "" } });
setEnv("LINEAR_APP_SOAK_ORG_ID", SOAK_ORG);
setEnv("LINEAR_APP_SOAK_CLIENT_ID", "soak-client-id");
setEnv("LINEAR_APP_SOAK_CLIENT_SECRET", "soak-client-secret");

let bearers: string[] = [];
let bodies: Array<{ query?: string; variables?: { input?: Record<string, unknown> } }> = [];

const savedFetch = globalThis.fetch;
function stubLinear(graphqlData: unknown): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: SOAK_MINTED, expires_in: 3600 }), { status: 200 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    bearers.push(headers["authorization"] ?? headers["Authorization"] ?? "(none)");
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as (typeof bodies)[number]);
    return new Response(JSON.stringify({ data: graphqlData }), { status: 200 });
  }) as unknown as typeof fetch;
}
const lastBearer = (): string => bearers[bearers.length - 1] ?? "(no call)";

function reset(): void {
  bearers = [];
  bodies = [];
  _resetLinearMintCache();
}

try {
  {
    stubLinear({ agentActivityCreate: { success: true, agentActivity: { id: "act-1" } } });

    reset();
    await linearPostArm.dispatchReply!({ platform: "linear", agentSessionId: "sess-1", organizationId: SOAK_ORG } as ReplyTarget, "hi");
    ok(
      lastBearer() === `Bearer ${SOAK_MINTED}`,
      `🔴 THE FIX: an agent-session reply in the SOAK workspace presents the SOAK app's OWN minted token — got "${lastBearer()}"`,
    );

    reset();
    await linearPostArm.dispatchReply!({ platform: "linear", agentSessionId: "sess-1" } as ReplyTarget, "hi");
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: the same reply with NO organization id still presents the PRIMARY token (unchanged behaviour)");

    reset();
    await linearPostArm.dispatchReply!({ platform: "linear", agentSessionId: "sess-1", organizationId: OTHER_ORG } as ReplyTarget, "hi");
    ok(
      lastBearer() === `Bearer ${PRIMARY_TOKEN}`,
      "NEGATIVE CONTROL: an UNREGISTERED organization falls through to the primary chain — org-keying never invents a credential",
    );

    stubLinear({ commentCreate: { success: true } });
    reset();
    await linearPostArm.dispatchReply!({ platform: "linear", issueId: "ISS9", parentId: "C1", organizationId: SOAK_ORG } as ReplyTarget, "hi");
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: the AMBIENT commentCreate route presents the SOAK token too");
    ok(bodies[bodies.length - 1]?.query?.includes("commentCreate") === true, "…and it is still the commentCreate mutation (the route did not change, only the credential)");

    reset();
    await linearPostArm.dispatchReply!({ platform: "linear", issueId: "ISS9", parentId: "C1" } as ReplyTarget, "hi");
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: the ambient route with no organization id presents the PRIMARY token");
  }

  {
    const deps = {} as UnifiedReplyDeps;

    stubLinear({ agentActivityCreate: { success: true, agentActivity: { id: "act-2" } } });
    reset();
    const mention = { platform: "linear", issueId: "ISS2", agentSessionId: "sess-2", organizationId: SOAK_ORG } as Extract<UnifiedWakeOrigin, { platform: "linear" }>;
    await linearPostArm.dispatchUnified!(mention, "the answer", deps);
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: the unified MENTION arm presents the SOAK token");

    reset();
    await linearPostArm.closeUnifiedSilently!(mention, deps);
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: the SILENCE ACK presents the SOAK token — a session it cannot complete stays on a spinner forever");

    reset();
    await linearPostArm.dispatchUnified!({ platform: "linear", issueId: "ISS2", agentSessionId: "sess-2" } as Extract<UnifiedWakeOrigin, { platform: "linear" }>, "the answer", deps);
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: the unified mention arm with no organization id presents the PRIMARY token");

    stubLinear({ commentCreate: { success: true } });
    reset();
    await linearPostArm.dispatchUnified!(
      { platform: "linear", issueId: "ISS3", ambient: true, organizationId: SOAK_ORG } as Extract<UnifiedWakeOrigin, { platform: "linear" }>,
      "the answer",
      deps,
    );
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: the unified AMBIENT arm presents the SOAK token");
  }

  {
    stubLinear({ reactionCreate: { success: true } });
    reset();
    await linearPostArm.react!({ platform: "linear", issueId: "ISS4", organizationId: SOAK_ORG } as ReactTarget, "eyes");
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: a react in the SOAK workspace presents the SOAK token");

    reset();
    await linearPostArm.react!({ platform: "linear", issueId: "ISS4" } as ReactTarget, "eyes");
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: a react with no organization id presents the PRIMARY token");

    type Bag = Parameters<NonNullable<typeof linearPostArm.resolveTarget>>[0];
    const bag = (fields: Record<string, string>): Bag => ({ str: (k: string) => fields[k], num: () => undefined, ctx: {} as never }) as Bag;

    assert.deepStrictEqual(
      linearPostArm.resolveTarget!(bag({ agentSessionId: "sess-9", organizationId: SOAK_ORG })),
      { platform: "linear", agentSessionId: "sess-9", organizationId: SOAK_ORG },
      "resolveTarget carries the workspace onto the AGENT-SESSION route",
    );
    passed++;
    assert.deepStrictEqual(
      linearPostArm.resolveTarget!(bag({ issueId: "ISS9", parentId: "C1", organizationId: SOAK_ORG })),
      { platform: "linear", issueId: "ISS9", parentId: "C1", organizationId: SOAK_ORG },
      "resolveTarget carries the workspace onto the AMBIENT route",
    );
    passed++;
    assert.deepStrictEqual(
      linearPostArm.resolveTarget!(bag({ agentSessionId: "sess-9" })),
      { platform: "linear", agentSessionId: "sess-9" },
      "NEGATIVE CONTROL: no workspace on the bag ⇒ the key is ABSENT, not undefined — the target is byte-identical to before this ticket",
    );
    passed++;
    assert.deepStrictEqual(
      linearPostArm.resolveReactTarget!(bag({ issueId: "ISS9", organizationId: SOAK_ORG })),
      { platform: "linear", issueId: "ISS9", organizationId: SOAK_ORG },
      "resolveReactTarget carries the workspace too",
    );
    passed++;
  }

  {
    const nodeRequire = createRequire(import.meta.url);
    const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
    const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
    const { ContextContainer, contextStorage } = (await import(abs("dist/src/context/container.js"))) as {
      ContextContainer: new () => unknown;
      contextStorage: { run<T>(c: unknown, fn: () => T): T };
    };
    const { SessionKey } = (await import(abs("dist/src/context/keys.js"))) as { SessionKey: unknown };

    const inSession = <T>(fn: () => Promise<T>, attributes?: Record<string, string>): Promise<T> => {
      const c = new ContextContainer() as { set(k: unknown, v: unknown): void };
      c.set(SessionKey, { sessionId: "linear-multi-org-test", auth: attributes ? { current: { attributes }, initiator: null } : null, turn: 1, parent: undefined });
      return contextStorage.run(c, fn);
    };

    const linearModule = (await import("../agent/channels/linear.js")) as unknown as {
      default: { adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>> };
      _resetLinearPristineChannels(): void;
    };
    linearModule._resetLinearPristineChannels();
    const adapter = linearModule.default.adapter;

    const nativeState = () => ({ agentSessionId: "sess-native", organizationId: null, pendingToolCallMessage: null });

    stubLinear({ agentActivityCreate: { success: true, agentActivity: { id: "act-eve" } } });

    reset();
    const soakState = nativeState();
    await inSession(async () => {
      await adapter["turn.started"]!({}, { state: soakState });
      await adapter["message.completed"]!({ finishReason: "stop", message: "here is the answer" }, { state: soakState });
    }, { organization_id: SOAK_ORG, agent_session_id: "sess-native", issue_id: "ISS-EVE" });
    ok(bearers.length >= 2, `eve's OWN defaults really ran — ${bearers.length} Agent-Activity calls went out (progress + the answer)`);
    ok(
      bearers.every((b) => b === `Bearer ${SOAK_MINTED}`),
      `🔴 THE FIX: EVERY activity eve's default handlers posted for a SOAK wake carries the SOAK token — got ${JSON.stringify(bearers)}`,
    );
    ok(
      bodies.some((b) => JSON.stringify(b.variables?.input ?? {}).includes("here is the answer")),
      "…and the ANSWER itself is one of them — this is the native @mention reply, not just a progress ping",
    );

    reset();
    const primaryState = nativeState();
    await inSession(async () => {
      await adapter["turn.started"]!({}, { state: primaryState });
      await adapter["message.completed"]!({ finishReason: "stop", message: "here is the answer" }, { state: primaryState });
    }, { agent_session_id: "sess-native", issue_id: "ISS-EVE" });
    ok(bearers.length >= 2, "negative control: eve's defaults ran on this drive too");
    ok(
      bearers.every((b) => b === `Bearer ${PRIMARY_TOKEN}`),
      `NEGATIVE CONTROL: with no workspace on the delivery, every default post keeps the PRIMARY token — got ${JSON.stringify(bearers)}`,
    );

    ok(
      (soakState as unknown as Record<string, unknown>).oeOrganizationId === SOAK_ORG,
      "turn.started stamps the wake's workspace onto the session state — message.completed has no auth ctx of its own to read",
    );
    ok(
      (primaryState as unknown as Record<string, unknown>).oeOrganizationId === undefined,
      "NEGATIVE CONTROL: no workspace on the delivery ⇒ NO stamp (never a claim the delivery did not make)",
    );
  }

  {
    stubLinear({ commentUpdate: { success: true } });
    reset();
    await linearPostArm.editMessage!({ platform: "linear", channelId: "ISS9", organizationId: SOAK_ORG }, "cm-1", "corrected");
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: editMessage against a locus in the SOAK workspace presents the SOAK token");
    ok(bodies[bodies.length - 1]?.query?.includes("commentUpdate") === true, "…and it is the commentUpdate mutation");

    reset();
    await linearPostArm.editMessage!({ platform: "linear", channelId: "ISS9" }, "cm-1", "corrected");
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: editMessage with no organization id on the locus presents the PRIMARY token");
  }
} finally {
  globalThis.fetch = savedFetch;
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

assert.ok(passed > 0);
console.log(`✓ linear-multi-org-reply: ${passed} assertions passed`);
