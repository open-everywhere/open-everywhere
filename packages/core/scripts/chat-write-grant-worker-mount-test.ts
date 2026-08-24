import assert from "node:assert/strict";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

await import("./_register-test-config.js");

const { registerConfig, getConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { defineDomain, domainForChannel } = await import("../agent/memory/domain.js");
const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { chatWriteMount, chatWriteTargets } = await import("../agent/access/chat-write-grant.js");
const { chatDmMount, chatDmTargets } = await import("../agent/access/chat-dm-grant.js");
const { resourceAddress } = await import("../agent/access/resource-grant.js");
const { personAddress } = await import("../agent/channels/dm-audience.js");
const { formatWindowToken, taskWindowId } = await import("../agent/channels/window-key.js");
const { stampUnifiedWindowAuth } = await import("../agent/channels/unified-window.js");

type Ctx = import("../agent/identity/binding.js").BindableContext;
type Domain = import("../agent/memory/domain.js").Domain;

registerSlackFixtureMapper();

const HOME = "slack/T1/C_HOME";
const ELSEWHERE_ID = "C_ELSEWHERE";
const ELSEWHERE = resourceAddress("slack", "channel", ELSEWHERE_ID);
const DM_TARGET = personAddress("slack", "U_SARAH");

const DOMAINS: readonly Domain[] = [defineDomain({ name: "eng", channels: [HOME, `slack/T1/${ELSEWHERE_ID}`] })];

const base = getConfig();
registerConfig({
  ...base,
  loadBundles: () => [
    defineBundle({
      name: "eng-chat",
      resourceGrants: [
        { connector: "slack", resources: [ELSEWHERE] },
        { connector: "slack", resources: [DM_TARGET], capabilities: ["dm"] },
      ],
    }),
  ],
  loadBindings: () => [defineBinding({ bundle: "eng-chat", scope: { level: "org" } })],
  loadDomains: () => DOMAINS,
  domainsForSurface: ({ workspaceKey, surface }: { workspaceKey: string; surface: string }) => {
    const d = domainForChannel(`${workspaceKey}/${surface}`, DOMAINS);
    return d ? [d.name] : [];
  },
});

function seatAttributes(): Record<string, string> {
  const seatToken = formatWindowToken({ domain: "eng", windowId: "eng", generation: 3 });
  return (
    stampUnifiedWindowAuth(
      {
        attributes: {
          team_id: "T1",
          channel_id: "C_HOME",
          channel_type: "channel",
          is_private: "false",
          trust_checked: "true",
          is_ext_shared: "false",
          user_id: "U_ASKER",
        },
      },
      "slack",
      "wake-1",
      undefined,
      ["slack/T1"],
      seatToken,
    ) as { attributes: Record<string, string> }
  ).attributes;
}

function ctxFrom(attributes: Record<string, string>, continuationToken: string, sessionId: string): Ctx {
  return {
    channel: { kind: "unified", continuationToken },
    session: { id: sessionId, auth: { current: { attributes } } },
  } as unknown as Ctx;
}

const seatCtx = ctxFrom(seatAttributes(), `unified:${formatWindowToken({ domain: "eng", windowId: "eng", generation: 3 })}`, "seat-session");

function workerCtxFrom(parentAttributes: Readonly<Record<string, string>>): Ctx {
  const taskToken = formatWindowToken({ domain: "eng", windowId: taskWindowId("slack/T1/C_HOME", "1720.9", "nonce1"), generation: 3 });
  const dispatched: Record<string, string> = { ...parentAttributes, oe_grain: "task" };
  const attributes = (
    stampUnifiedWindowAuth({ attributes: dispatched }, "slack", "wake-2", "direct-mention", ["slack/T1"], taskToken) as {
      attributes: Record<string, string>;
    }
  ).attributes;
  return ctxFrom(attributes, `unified:${taskToken}`, "worker-session");
}

{
  const seatSurfaceKey = resolvePartition(seatCtx).surfaceKey;
  ok(seatSurfaceKey === HOME, "sanity: the seat itself resolves the fixture's home surface");
  ok(chatWriteMount(seatCtx, () => DOMAINS), "sanity: the seat's own ctx mounts post_message's grant (chatWriteMount)");
  ok(chatDmMount(seatCtx, () => DOMAINS), "sanity: the seat's own ctx mounts dm_person's grant (chatDmMount)");

  const worker = workerCtxFrom(seatAttributes());
  ok(resolvePartition(worker).surfaceKey === seatSurfaceKey, "a worker's own session resolves the SAME surfaceKey as the seat that spawned it");

  ok(chatWriteMount(worker, () => DOMAINS), "🔴 the worker mounts post_message — the tier-P1 chat-write grant reaches a delegated worker's own session");
  const writeTargets = chatWriteTargets(worker, DOMAINS);
  ok(writeTargets.length === 1 && writeTargets[0]?.address === ELSEWHERE, "…and resolves the SAME granted target the seat itself would resolve");

  ok(chatDmMount(worker, () => DOMAINS), "🔴 the worker mounts dm_person — the tier-P2 chat-dm grant (OPE-1064) reaches a delegated worker's own session, same mechanism");
  const dmTargets = chatDmTargets(worker, DOMAINS);
  ok(dmTargets.length === 1 && dmTargets[0]?.address === DM_TARGET, "…and resolves the SAME granted person the seat itself would resolve");
}

{
  const taskToken = formatWindowToken({ domain: "eng", windowId: taskWindowId("slack/T1/C_HOME", "1720.9", "nonce2"), generation: 3 });
  const brokenWorker = ctxFrom({}, `unified:${taskToken}`, "broken-worker");
  ok(resolvePartition(brokenWorker).surfaceKey !== HOME, "a worker ctx with no stamped identity at all does NOT resolve the fixture's home surface");
  ok(!chatWriteMount(brokenWorker, () => DOMAINS), "…and chatWriteMount correctly reports false on it — the §1 pass is not vacuous");
  ok(!chatDmMount(brokenWorker, () => DOMAINS), "…and chatDmMount correctly reports false on it either — same non-vacuity for the DM sibling");
}

console.log(`\n✓ chat-write-grant-worker-mount: ${n} assertions passed (worker/seat parity for chatWriteMount + chatDmMount, non-vacuously)\n`);
