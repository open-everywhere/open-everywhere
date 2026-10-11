import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";

import { bootAgent, runScheduleTask } from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const SIEM = "https://siem.ope2437.example/";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

interface ReceivedRecord {
  readonly seq: number;
  readonly org: string;
  readonly action: string;
  readonly prevSha: string | null;
  readonly sha: string;
}

test("the compiled audit-export cron task streams settled audit rows to the configured SIEM, chain fields included", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = `ope2437-${deploymentOrg()}`;
  const store = getOperationalStore();

  const bodies: string[] = [];
  let status = 200;
  const siem = installHostFetchStub(SIEM, (_url, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response("{}", { status });
  });
  cleanups.push(() => siem.uninstall());

  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  await store.appendAudit({ org, ts: old, platform: "slack", workspace: "T-ope2437", surface: "C-ope2437", action: "test.siem_export_a", detail: { n: 1 } });
  await store.appendAudit({ org, ts: old, platform: "slack", workspace: "T-ope2437", surface: "C-ope2437", action: "test.siem_export_b", detail: { n: 2 } });

  await runScheduleTask("schedules/audit-export.ts");
  expect(siem.calls.length, "with no target configured, the task sends nothing").toBe(0);

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ auditExport: { targets: [{ name: "it-siem", format: "json", url: `${SIEM}ingest`, orgs: [org] }] } });
  cleanups.push(() => settings.overrideSettingsForTest({ auditExport: { targets: [] } }));

  status = 503;
  await runScheduleTask("schedules/audit-export.ts");
  expect(siem.calls.length, "the task POSTs to the configured receiver").toBeGreaterThan(0);
  expect(await store.getMeta(`audit.export.cursor.v1:it-siem:${org}`), "a 503 leaves the cursor unset").toBeNull();

  status = 200;
  bodies.length = 0;
  await runScheduleTask("schedules/audit-export.ts");
  const records = bodies.flatMap((b) => JSON.parse(b) as ReceivedRecord[]);
  const ours = records.filter((r) => r.action === "test.siem_export_a" || r.action === "test.siem_export_b");
  expect(ours.map((r) => r.action)).toEqual(["test.siem_export_a", "test.siem_export_b"]);
  expect(ours.every((r) => r.org === org && typeof r.sha === "string" && r.sha.length === 64)).toBe(true);
  expect(ours[1]!.prevSha, "each record's prevSha is the previous record's sha").toBe(ours[0]!.sha);
  const cursor = await store.getMeta(`audit.export.cursor.v1:it-siem:${org}`);
  expect(Number(cursor), "the cursor names the last acknowledged seq").toBe(records[records.length - 1]!.seq);

  const before = siem.calls.length;
  await runScheduleTask("schedules/audit-export.ts");
  expect(siem.calls.length, "nothing new settled ⇒ nothing sent").toBe(before);
});
