// proves: SEAT-46

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import type { RedriveReinject } from "../agent/channels/unified-redrive.js";

import { registerSlackFixtureMapper, registerSlackFixturePostArm, registerSlackFixtureCodec, registerSlackTestBridge } from "./_slack-test-stubs.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
registerSlackFixtureMapper();
registerSlackFixturePostArm();
registerSlackFixtureCodec();
registerSlackTestBridge();

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-unified-redrive-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
delete process.env.OE_SPAWN_DISPATCH_SECRET;

const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { renderWake, mkMessageTrigger } = await import("../agent/channels/normalized-wake.js");
const { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } = await import("../agent/access/untrusted.js");
const {
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
  process.env.OE_UNIFIED_REDRIVE = "0";
  await registerUnifiedWakeTarget(store, ORG, "wake-no-switch", SLACK_ORIGIN, new Date().toISOString());
  const injected: Captured[] = [];
  const res = await maybeRedrive(
    { org: ORG, workspace: "p", wakeId: "wake-no-switch", chars: 200, replied: false },
    { store, reinject: makeReinject(injected), audit: makeAudit([]) },
  );
  ok(res.status === "redriven" && injected.length === 1, "🔴 no off switch: a stray OE_UNIFIED_REDRIVE=0 cannot suppress the correction — the redrive fires");
  delete process.env.OE_UNIFIED_REDRIVE;
}

{
  const W = "wake-original-1";
  const msg = renderWake(buildRedriveWake(W, SLACK_ORIGIN, 137, "2026-07-13T00:00:00Z")).message;
  ok(msg.startsWith("<wake "), "wake: the corrective delivery is the envelope alone (OPE-753 — nothing renders above it)");
  ok(msg.includes('addressing="channel-watch"'), "wake: AMBIENT channel-watch addressing — a machine notice about the model's own output");
  ok(!msg.includes('addressing="direct-mention"') && !msg.includes('mention="true"'), "wake: NOT an addressed direct-mention — the correction must not claim an address no person made");
  ok(msg.includes(`wake-id="${W}"`), "wake: the envelope RE-STAMPS the ORIGINAL wake-id (the reply fence + reply tool target it)");
  ok(msg.includes('from="system"'), "wake: sender is system (a machine-authored notice, not a fake human)");
  ok(msg.includes('trust="relay"'), "wake: trust tier is relay (machine/self echo — the tier for the agent's own output)");
  ok(msg.includes("137 chars") && msg.includes(W), "wake: the corrective body names the dropped char count + the original wake-id");

  ok(redriveCorrectiveText(10, "W9", SLACK_ORIGIN).includes("DISCARDED by the message-tool-only gate"), "corrective text: states the drop plainly");
  ok(redriveCorrectiveText(10, "W9", SLACK_ORIGIN).includes("no_reply"), "corrective text: offers the no_reply escape (silence stays valid — never coerces a reply)");
  ok(describeRedriveTarget(SLACK_ORIGIN) === "slack channel C_PAY", "target description: slack channel");

  const fenceOpen = msg.indexOf(UNTRUSTED_OPEN);
  const fenceClose = msg.indexOf(UNTRUSTED_CLOSE, fenceOpen);
  ok(fenceOpen !== -1 && fenceClose > fenceOpen, "wake: the machine trigger body is STILL fenced (no unfenced machine body)");
  const fenced = msg.slice(fenceOpen, fenceClose);
  ok(!fenced.includes("DISCARDED") && !fenced.includes("no_reply"), "🔴 wake: the corrective instruction is NOT inside the untrusted fence");
  ok(fenced.includes(`Corrective re-drive of wake ${W}.`), "wake: the fenced body is the one-line marker only");
  const note = msg.indexOf("<system-note>");
  ok(note > msg.lastIndexOf("</channel>") && note < msg.lastIndexOf("</wake>"), "🔴 wake: the correction renders as a trusted <system-note> after </channel>, inside <wake>");
  const noteText = msg.slice(note, msg.indexOf("</system-note>", note));
  ok(noteText.includes("DISCARDED by the message-tool-only gate") && noteText.includes("137 chars") && noteText.includes(W) && noteText.includes("no_reply"), "wake: the system-note carries the whole instruction (drop, chars, wake id, no_reply escape)");
  ok(msg.indexOf("DISCARDED") > msg.lastIndexOf("</channel>"), "wake: no copy of the instruction renders anywhere inside <channel>");

  const plain = renderWake({
    platform: "slack",
    reason: "channel-activity",
    addressing: "channel-watch",
    wakeId: W,
    locus: { channel: { id: "C_PAY" } },
    trigger: mkMessageTrigger({ from: "bot", author: "relay-bot", id: "9.9", sentAt: "2026-07-13T00:00:00Z", trust: "relay", body: redriveCorrectiveText(137, W, SLACK_ORIGIN) }),
  }).message;
  const pOpen = plain.indexOf(UNTRUSTED_OPEN);
  const pClose = plain.indexOf(UNTRUSTED_CLOSE, pOpen);
  ok(pOpen !== -1 && plain.slice(pOpen, pClose).includes("DISCARDED by the message-tool-only gate"), "🔴 NEGATIVE CONTROL: the corrective text in a plain relay BODY renders INSIDE the fence");
  ok(!plain.includes("<system-note>"), "🔴 NEGATIVE CONTROL: …and a body carrying the text appends NO system-note");

  const owing = redriveCorrectiveText(10, "W9", SLACK_ORIGIN, true);
  ok(owing.includes("`done: false`"), "🔴 corrective text: on a turn whose worker still owes the wake, the nudge NAMES `done: false` — the one call that is not refused");
  ok(owing.includes("still owes this conversation"), "corrective text: …and says why, so the model is not following an unexplained flag");
  ok(!redriveCorrectiveText(10, "W9", SLACK_ORIGIN).includes("done"), "🔴 corrective text/NEGATIVE CONTROL: an ordinary correction names no `done` at all");
  ok(!redriveCorrectiveText(10, "W9", SLACK_ORIGIN, false).includes("done"), "corrective text/NEGATIVE CONTROL: …and the explicit false is the same text as the default");
  const owingWake = renderWake(buildRedriveWake("W9", SLACK_ORIGIN, 10, new Date().toISOString(), true)).message;
  ok(owingWake.includes("`done: false`"), "🔴 corrective wake: the flag survives the render, so the model really reads it");
  ok(!renderWake(buildRedriveWake("W9", SLACK_ORIGIN, 10, new Date().toISOString())).message.includes("done"), "corrective wake/NEGATIVE CONTROL: …and the ordinary one carries none");
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
  const injected: Captured[] = [];
  const audits: Record<string, unknown>[] = [];
  const W_DM = "wake-direct-mention-1982";
  await registerUnifiedWakeTarget(store, ORG, W_DM, SLACK_ORIGIN, new Date().toISOString());

  const first = await maybeRedrive(
    { org: ORG, workspace: "p", sessionId: "sess-dm", wakeId: W_DM, chars: 3, replied: false },
    { store, reinject: makeReinject(injected), audit: makeAudit(audits) },
  );
  ok(first.status === "redriven", "🔴 OPE-1982: a DIRECT-MENTION turn's dropped prose is re-driven — the same correction an unaddressed drop gets, because this module reads no addressing at all");
  ok(injected.length === 1 && injected[0].wakeId === W_DM, "OPE-1982: …the corrective wake carries the ORIGINAL wake id, so the seat's `reply` resolves the conversation the mention came from");
  ok(injected[0] !== undefined && !injected[0].message.includes('addressing="direct-mention"'), "🔴 OPE-1982: …and the correction itself is AMBIENT — a machine notice must not claim an address no person made");
  ok(audits.filter((e) => e.action === REDRIVE_ACTION).length === 1, "OPE-1982: exactly ONE unified.turn.redrive row — the count an operator reads to see how often the tool was missed");

  const second = await maybeRedrive(
    { org: ORG, workspace: "p", sessionId: "sess-dm", wakeId: W_DM, chars: 3, replied: false },
    { store, reinject: makeReinject(injected), audit: makeAudit(audits) },
  );
  ok(second.status === "skip-loop-guard", "🔴 OPE-1982: a SECOND prose-only ending on the same wake is NOT re-driven — the cap is one, and the drop is final");
  ok(injected.length === 1, "OPE-1982: …so nothing further is injected");
  ok(audits.filter((e) => e.action === REDRIVE_ACTION).length === 1, "🔴 OPE-1982/NEGATIVE CONTROL: …and the row count did not move, so `skip-loop-guard` really is silence and not a second correction under another name");
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
  const { buildRedriveReinject, divertToUnifiedWindow } = await import("../agent/channels/unified.js");
  const { mintWakeId } = await import("../agent/channels/unified-window.js");

  overrideSettingsForTest({ window: { topology: true } });
  const PAY_SLACK = "slack/T_PAY/C_PAY";
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "payments", reach: [PAY_SLACK], ambientSupervisor: true, mode: "unified" })],
    loadSilos: () => [],
    domainsForSurface: ({ surface }) => (surface === "C_PAY" ? ["payments"] : []),
  });

  const rawToken = unifiedSupervisorToken("payments", 1);

  ok(buildRedriveReinject("payments", rawToken, {}) === null, "reinject: NULL when no cross-process dispatch is reachable (fail-soft source of skip-no-reinject)");

  interface Landed { message: string; token: string; wakeId: string; origin: UnifiedWakeOrigin }
  const landed: Landed[] = [];
  const captureReceive = ((_ch: unknown, target: { token: string; wakeId: string; origin: UnifiedWakeOrigin }) => ({
    async send(message: string) {
      landed.push({ message, token: target.token, wakeId: target.wakeId, origin: target.origin });
      return {} as never;
    },
  })) as unknown as Parameters<typeof divertToUnifiedWindow>[0];
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

console.log(`✓ unified-redrive: ${n} assertions passed (no off switch + corrective-wake render/re-stamp + fire-once/loop-guard/skips/fail-soft/throw over a real sqlite guard + buildRedriveReinject unavailable/warm arms)`);
