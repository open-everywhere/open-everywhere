process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import "./_register-test-config.js";
import { liveSupervisorDeps, type WakeSend } from "../agent/channels/slack-events.js";
import { withSingleWindowDiversion } from "../agent/channels/slack-front.js";
import { getOperationalStore, deploymentOrg, RUN_KEY_FETCH_MARKER, HTTP_404_MARKER, PRUNED_DEPLOYMENT_AUDIT_ACTION } from "@open-everywhere/core/agent/adapter-api.js";
import type { RouteHandlerArgs } from "eve/channels";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

const SURFACE = "slack/T0AAAAAAA/C0123456";
const unusedTo = (() => {
  throw new Error("withSingleWindowDiversion's native branch must never call `to`");
}) as unknown as RouteHandlerArgs["to"];

{
  const org = deploymentOrg();
  await getOperationalStore().rotateChannelSession(org, SURFACE, "seed-tok", "2026-08-22T00:00:00.000Z");
  const before = await getOperationalStore().getChannelSession(org, SURFACE);
  ok(before?.rotateMarkedAt == null, "wiring precondition: the channel's seat starts UNMARKED (so a green below cannot be vacuous)");

  const boom = new Error(`${RUN_KEY_FETCH_MARKER} for wrun_TEST (deployment dpl_TEST): ${HTTP_404_MARKER} Not Found`);
  const failingSend: WakeSend = async () => {
    throw boom;
  };
  const wrapped = withSingleWindowDiversion(liveSupervisorDeps(failingSend), unusedTo, SURFACE);

  let threw: unknown;
  try {
    await wrapped.wake({
      token: "C0123456:oe-sup:g1",
      auth: { attributes: {} },
      message: "<wake>hi</wake>",
      state: undefined,
    });
  } catch (err) {
    threw = err;
  }
  ok(threw === boom, "🔴 the native send failure still PROPAGATES unchanged — this is an audit ADDITION, not a swallow");

  const after = await getOperationalStore().getChannelSession(org, SURFACE);
  ok(after?.rotateMarkedAt != null, "🔴 OPE-971: the NATIVE (flag-off) wake heal MARKED the channel's own seat for rotation — supervisorGrainFor's registryKey === surfaceKey flag-off");
  const strandRows = (await getOperationalStore().readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "C0123456:oe-sup:g1",
  );
  eq(strandRows.length, 1, "…and wrote exactly ONE strand audit row for this token");
  eq(strandRows[0]!.workspace, "T0AAAAAAA", "…workspace is the surfaceKey's own second segment, not `unknown`");
  eq((strandRows[0]!.detail as Record<string, unknown>).registryKey, SURFACE, "…the row names the registryKey it marked");
}

{
  const org = deploymentOrg();
  const before = await getOperationalStore().getChannelSession(org, SURFACE);
  const transient = new Error("socket hang up");
  const failingSend: WakeSend = async () => {
    throw transient;
  };
  const wrapped = withSingleWindowDiversion(liveSupervisorDeps(failingSend), unusedTo, SURFACE);

  await wrapped
    .wake({
      token: "transient-tok",
      auth: { attributes: {} },
      message: "<wake>hi</wake>",
      state: undefined,
    })
    .catch(() => undefined);

  const after = await getOperationalStore().getChannelSession(org, SURFACE);
  eq(after?.rotateMarkedAt, before?.rotateMarkedAt, "negative control: a TRANSIENT native send failure changes NOTHING about the seat's mark state");
  const strandRows = (await getOperationalStore().readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "transient-tok",
  );
  eq(strandRows.length, 0, "…and writes no strand audit row either");
}

{
  const deps = liveSupervisorDeps((async () => {
    throw new Error("deps.wake must never be called on a window-carrying input");
  }) as WakeSend);
  const received: unknown[] = [];
  const capturingTo = ((_channel: unknown, _target: unknown) => ({
    async send(message: string, opts: unknown) {
      received.push({ message, opts });
      return {};
    },
  })) as unknown as RouteHandlerArgs["to"];
  const wrapped = withSingleWindowDiversion(deps, capturingTo, SURFACE);
  await wrapped.wake({
    token: "oe-dom:acme:oe-sup:g1",
    auth: { attributes: {} },
    message: "<wake>hi</wake>",
    state: undefined,
    window: { wakeId: "w1", origin: { platform: "slack", channelId: "C0123456" } },
  });
  eq(received.length, 1, "a window-carrying wake still diverts through `to`, untouched by the OPE-971 native wrapping");
}

console.log(`✓ slack-native-wake-heal: ${n} assertions passed (OPE-971 native flag-off pruned-deployment heal + negative control + window-branch untouched)`);
