import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { CORE_PACKAGE_VERSION } from "@open-everywhere/core/agent/ops/package-info.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { upgradeOfferMetaKey } from "@open-everywhere/core/agent/schedules/upgrade-offer.js";
import { __setTestValveForTest, testValveArmed } from "@open-everywhere/core/agent/testing/test-valves.js";

import { auditCursor, bootAgent, installSlackWebApiStub, rowsSinceCursor, runScheduleTask } from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const REGISTRY = "https://registry.npmjs.org/";
const ADMIN_CHANNEL = "C_OPE2237_ADMIN";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function nextPatch(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

test("the compiled upgrade-offer cron task posts one offer of a newer release in the admin channel, and only once", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const latest = nextPatch(CORE_PACKAGE_VERSION);

  const registry = installHostFetchStub(REGISTRY, () => new Response(JSON.stringify({ name: "@open-everywhere/core", version: latest }), { status: 200 }));
  cleanups.push(() => registry.uninstall());
  const slack = installSlackWebApiStub((method) => (method === "chat.postMessage" ? { ok: true, ts: "1.0" } : undefined));
  cleanups.push(() => slack.uninstall());
  const posts = () => slack.calls.filter((c) => c.method === "chat.postMessage");

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const prev = settings.getSettings();
  cleanups.push(() =>
    settings.overrideSettingsForTest({
      accessRequests: { adminChannel: prev.accessRequests.adminChannel, configRepo: prev.accessRequests.configRepo },
      schedules: { sweepOrgs: prev.schedules.sweepOrgs },
    }),
  );
  const fire = async (): Promise<void> => {
    const spoof = testValveArmed("egress-spoof");
    __setTestValveForTest("egress-spoof", false);
    try {
      await runScheduleTask("schedules/upgrade-offer.ts");
    } finally {
      __setTestValveForTest("egress-spoof", spoof);
    }
  };
  const outcomes = async (cursor: Awaited<ReturnType<typeof auditCursor>>): Promise<unknown[]> =>
    (await rowsSinceCursor(cursor, ["upgrade.offer_tick"])).map((r) => r.detail?.outcome);

  settings.overrideSettingsForTest({ schedules: { sweepOrgs: [org] }, accessRequests: { configRepo: "acme/agent", adminChannel: "" } });
  const c0 = await auditCursor();
  await fire();
  expect(registry.calls.length, "the compiled task reads the registry").toBeGreaterThan(0);
  expect(posts().length, "with no admin channel, the task posts nothing").toBe(0);
  expect(await outcomes(c0), "the tick says why it posted nothing").toContain("skipped: no admin channel configured");
  expect((await rowsSinceCursor(c0, ["upgrade.offered"])).length, "and records no offer").toBe(0);

  settings.overrideSettingsForTest({ schedules: { sweepOrgs: [org] }, accessRequests: { configRepo: "acme/agent", adminChannel: ADMIN_CHANNEL } });
  const c1 = await auditCursor();
  await fire();
  expect(posts().length, "the task posts the offer once").toBe(1);
  expect(posts()[0]!.params.get("channel")).toBe(ADMIN_CHANNEL);
  expect(posts()[0]!.params.get("text") ?? "").toContain(latest);
  expect(posts()[0]!.params.get("text") ?? "").toContain('"upgrade yourself"');
  expect((await rowsSinceCursor(c1, ["upgrade.offered"])).length, "the post writes one upgrade.offered row").toBe(1);
  expect(await getOperationalStore().getMeta(upgradeOfferMetaKey(latest)), "the once is recorded in the deployment meta").not.toBeNull();

  const c2 = await auditCursor();
  await fire();
  expect(posts().length, "a second run posts nothing for the same release").toBe(1);
  expect(await outcomes(c2), "the second tick stops at the meta key").toContain("no-op: already offered");
  expect((await rowsSinceCursor(c2, ["upgrade.offered"])).length, "and writes no second offered row").toBe(0);
});
