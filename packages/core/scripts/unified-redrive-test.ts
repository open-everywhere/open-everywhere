import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import type { RedriveReinject } from "../agent/channels/unified-redrive.js";

import { registerSlackFixtureMapper, registerSlackFixturePostArm, registerSlackFixtureCodec, registerSlackTestBridge } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();
registerSlackFixturePostArm();
registerSlackFixtureCodec();
registerSlackTestBridge();

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-unified-redrive-")), "ops.sqlite3");
delete process.env.OE_ORG;
delete process.env.OE_UNIFIED_REDRIVE;
delete process.env.OE_SPAWN_DISPATCH_SECRET;

const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { SINGLE_WINDOW_REPLY_MANDATE, renderWake } = await import("../agent/channels/normalized-wake.js");
const {
  redriveEnabled,
  redriveGuardKey,
  buildRedriveWake,
  redriveCorrectiveText,
  describeRedriveTarget,
  maybeRedrive,
  REDRIVE_ACTION,
} = await import("../agent/channels/unified-redrive.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ORG = "default";
const store = getOperationalStore();

const SLACK_ORIGIN: UnifiedWakeOrigin = { platform: "slack", channelId: "C_PAY" };

interface Captured { origin: UnifiedWakeOrigin; message: string; wakeId: string }
function makeReinject(sink: Captured[]): RedriveReinject {
  return async (origin, message, wakeId) => void sink.push({ origin, message, wakeId });
}
function makeAudit(sink: Record<string, unknown>[]): (e: Record<string, unknown>) => Promise<void> {
  return async (e) => void sink.push(e);
}

{
  const prev = process.env.OE_UNIFIED_REDRIVE;
  ok(redriveEnabled({} as NodeJS.ProcessEnv) === true, "flag: UNSET → ON (default-on, catch-and-correct)");
  ok(redriveEnabled({ OE_UNIFIED_REDRIVE: "1" } as unknown as NodeJS.ProcessEnv) === true, "flag: '1' → ON");
  ok(redriveEnabled({ OE_UNIFIED_REDRIVE: "on" } as unknown as NodeJS.ProcessEnv) === true, "flag: 'on' → ON");
  for (const off of ["0", "false", "no", "off", "OFF", "False"]) {
    ok(redriveEnabled({ OE_UNIFIED_REDRIVE: off } as unknown as NodeJS.ProcessEnv) === false, `flag: '${off}' → OFF`);
  }
  if (prev === undefined) delete process.env.OE_UNIFIED_REDRIVE;
  else process.env.OE_UNIFIED_REDRIVE = prev;
}

{
  const W = "wake-original-1";
  const msg = renderWake(buildRedriveWake(W, SLACK_ORIGIN, 137, "2026-07-13T00:00:00Z")).message;
  ok(msg.startsWith("[channel-watch]"), "wake: AMBIENT channel-watch preamble (its own prose is hard-dropped, never bridged)");
  ok(!msg.includes("[direct]"), "wake: NOT an addressed direct-mention (so the bridge can never fire on the corrective turn)");
  ok(msg.includes(`wake-id="${W}"`), "wake: the envelope RE-STAMPS the ORIGINAL wake-id (the reply fence + reply tool target it)");
  ok(msg.includes(SINGLE_WINDOW_REPLY_MANDATE), "wake: the single-window reply mandate is present (judged wake + wakeId ⇒ appended)");
  ok(msg.includes('from="system"'), "wake: sender is system (a machine-authored notice, not a fake human)");
  ok(msg.includes('trust="relay"'), "wake: trust tier is relay (machine/self echo — the tier for the agent's own output)");
  ok(msg.includes("137 chars") && msg.includes(W), "wake: the corrective body names the dropped char count + the original wake-id");

  ok(redriveCorrectiveText(10, "W9", SLACK_ORIGIN).includes("DISCARDED by the message-tool-only gate"), "corrective text: states the drop plainly");
  ok(redriveCorrectiveText(10, "W9", SLACK_ORIGIN).includes("no_reply"), "corrective text: offers the no_reply escape (silence stays valid — never coerces a reply)");
  ok(describeRedriveTarget(SLACK_ORIGIN) === "slack channel C_PAY", "target description: slack channel");
}

{
  const W = "wake-drop-a";
  await registerUnifiedWakeTarget(store, ORG, W, SLACK_ORIGIN, new Date().toISOString());
  const injected: Captured[] = [];
  const audits: Record<string, unknown>[] = [];
  const res = await maybeRedrive(
    { org: ORG, workspace: "payments", surface: "oe-domain::payments", sessionId: "sess-1", wakeId: W, chars: 200, replied: false },
    { store, reinject: makeReinject(injected), audit: makeAudit(audits) },
  );
  ok(res.status === "redriven" && res.originalWakeId === W, "drop: maybeRedrive fires (status=redriven) for a replied=false drop");
  ok(injected.length === 1, "drop: the corrective wake was re-injected exactly ONCE");
  ok(JSON.stringify(injected[0].origin) === JSON.stringify(SLACK_ORIGIN) && injected[0].wakeId === W, "drop: the re-injection carries the ORIGINAL origin + wake-id (the re-stamp — reply lands in the original conversation)");
  ok(injected[0].message.includes(`wake-id="${W}"`), "drop: the injected envelope carries the original wake-id");
  const row = audits.find((a) => a.action === REDRIVE_ACTION);
  ok(!!row && (row.detail as { originalWakeId?: string }).originalWakeId === W, "drop: a unified.turn.redrive audit row is written, joinable by originalWakeId");
  ok((row!.detail as { chars?: number; sessionId?: string; platform?: string }).chars === 200 && (row!.detail as { sessionId?: string }).sessionId === "sess-1" && (row!.detail as { platform?: string }).platform === "slack", "drop: the audit detail carries chars + sessionId + origin platform");

  const injected2: Captured[] = [];
  const audits2: Record<string, unknown>[] = [];
  const res2 = await maybeRedrive(
    { org: ORG, workspace: "payments", wakeId: W, chars: 88, replied: false },
    { store, reinject: makeReinject(injected2), audit: makeAudit(audits2) },
  );
  ok(res2.status === "skip-loop-guard" && injected2.length === 0, "loop guard: a SECOND drop for the same wake is NOT redriven (the redriven turn's own drop is FINAL)");
  ok(audits2.length === 0, "loop guard: the blocked redrive writes NO redrive audit row");
  ok((await store.markEventSeen(ORG, redriveGuardKey(W), new Date().toISOString(), 1000)) === false, "loop guard: the durable mark for the wake is set (survives process restarts)");
}

{
  const injected: Captured[] = [];
  const audits: Record<string, unknown>[] = [];
  const deps = { store, reinject: makeReinject(injected), audit: makeAudit(audits) };

  const rReplied = await maybeRedrive({ org: ORG, workspace: "p", wakeId: "wake-r", chars: 50, replied: true }, deps);
  ok(rReplied.status === "skip-replied", "skip: replied=true (benign narration after a real reply) is NEVER redriven");

  const rNoWake = await maybeRedrive({ org: ORG, workspace: "p", wakeId: undefined, chars: 50, replied: false }, deps);
  ok(rNoWake.status === "skip-no-wake", "skip: a turn with no wake-id (not a single-window wake) is NEVER redriven");

  const rUnresolved = await maybeRedrive({ org: ORG, workspace: "p", wakeId: "wake-never-registered", chars: 50, replied: false }, deps);
  ok(rUnresolved.status === "skip-unresolved", "skip: an unresolved wake origin (expired/unknown) fails closed — no re-stamp target, no redrive");

  ok(injected.length === 0 && audits.length === 0, "skip: none of the ineligible cases re-injected or audited");
}

{
  const W = "wake-no-receive";
  await registerUnifiedWakeTarget(store, ORG, W, SLACK_ORIGIN, new Date().toISOString());
  const soft = await maybeRedrive({ org: ORG, workspace: "p", wakeId: W, chars: 30, replied: false }, { store, reinject: null });
  ok(soft.status === "skip-no-reinject", "no-receive: a null reinject (cold workflow process) fails SOFT (drop stays final)");
  const injected: Captured[] = [];
  const retry = await maybeRedrive({ org: ORG, workspace: "p", wakeId: W, chars: 30, replied: false }, { store, reinject: makeReinject(injected) });
  ok(retry.status === "redriven" && injected.length === 1, "no-receive: the loop guard was NOT consumed by the soft skip — a later warm turn still redrives");
}

{
  process.env.OE_UNIFIED_REDRIVE = "0";
  const W = "wake-flag-off";
  await registerUnifiedWakeTarget(store, ORG, W, SLACK_ORIGIN, new Date().toISOString());
  const injected: Captured[] = [];
  const audits: Record<string, unknown>[] = [];
  const res = await maybeRedrive({ org: ORG, workspace: "p", wakeId: W, chars: 200, replied: false }, { store, reinject: makeReinject(injected), audit: makeAudit(audits) });
  ok(res.status === "disabled" && injected.length === 0 && audits.length === 0, "flag OFF: no reinject, no audit, no store touch — byte-identical no-op");
  ok((await store.markEventSeen(ORG, redriveGuardKey(W), new Date().toISOString(), 1000)) === true, "flag OFF: the guard was NOT touched (the redrive never ran)");
  delete process.env.OE_UNIFIED_REDRIVE;
}

{
  const W = "wake-throw";
  await registerUnifiedWakeTarget(store, ORG, W, SLACK_ORIGIN, new Date().toISOString());
  const throwing: RedriveReinject = async () => { throw new Error("post failed"); };
  const res = await maybeRedrive({ org: ORG, workspace: "p", wakeId: W, chars: 40, replied: false }, { store, reinject: throwing });
  ok(res.status === "reinject-failed", "throw: a re-injection that throws is treated as final (reinject-failed), never re-thrown");
  const injected: Captured[] = [];
  const again = await maybeRedrive({ org: ORG, workspace: "p", wakeId: W, chars: 40, replied: false }, { store, reinject: makeReinject(injected) });
  ok(again.status === "skip-loop-guard" && injected.length === 0, "throw: the guard WAS burned by the failed attempt — no infinite re-injection loop");
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
  const { buildRedriveReinject, divertToUnifiedWindow } = await import("../agent/channels/unified.js");
  const { mintWakeId } = await import("../agent/channels/unified-window.js");

  process.env.OE_WINDOW_TOPOLOGY = "1";
  const PAY_SLACK = "slack/T_PAY/C_PAY";
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "payments", channels: [PAY_SLACK], ambientSupervisor: true, mode: "unified" })],
    loadSilos: () => [],
    domainsForSurface: ({ surface }) => (surface === "C_PAY" ? ["payments"] : []),
  });

  const rawToken = unifiedSupervisorToken("payments", 1);

  ok(buildRedriveReinject("payments", rawToken, {}) === null, "reinject: NULL when no cross-process dispatch is reachable (fail-soft source of skip-no-reinject)");

  interface Landed { message: string; token: string; wakeId: string; origin: UnifiedWakeOrigin }
  const landed: Landed[] = [];
  const captureReceive = (async (_ch: unknown, o: { message: string; target: { token: string; wakeId: string; origin: UnifiedWakeOrigin } }) => {
    landed.push({ message: o.message, token: o.target.token, wakeId: o.target.wakeId, origin: o.target.origin });
    return {} as never;
  }) as unknown as Parameters<typeof divertToUnifiedWindow>[0];
  await divertToUnifiedWindow(captureReceive, { message: "prime", token: rawToken, window: { wakeId: mintWakeId(), origin: SLACK_ORIGIN }, surfaceKey: PAY_SLACK, auth: { attributes: {} } });
  landed.length = 0;

  const reinject = buildRedriveReinject("payments", rawToken, { some: "attr" });
  ok(reinject !== null, "reinject: non-null once a receive is captured (warm in-process path)");
  await reinject!(SLACK_ORIGIN, "CORRECTIVE-BODY-XYZ", "wake-warm-1");
  ok(landed.length === 1, "reinject warm: dispatched exactly once through the captured receive");
  ok(landed[0].token === rawToken && landed[0].wakeId === "wake-warm-1", "reinject warm: dispatched on the window token, re-stamped with the ORIGINAL wake-id");
  ok(JSON.stringify(landed[0].origin) === JSON.stringify(SLACK_ORIGIN), "reinject warm: carries the ORIGINAL origin (reply lands in the original conversation)");
  ok(landed[0].message.includes("CORRECTIVE-BODY-XYZ"), "reinject warm: the corrective body rides through as the wake message");
}

console.log(`✓ unified-redrive: ${n} assertions passed (flag default-on/off + corrective-wake render/re-stamp + fire-once/loop-guard/skips/fail-soft/throw over a real sqlite guard + buildRedriveReinject unavailable/warm arms)`);
