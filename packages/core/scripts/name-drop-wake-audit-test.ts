import assert from "node:assert/strict";
import {
  auditNameDropWoke,
  auditNameDropSilent,
  nameDropAuditRow,
  NAME_DROP_WOKE_ACTION,
  NAME_DROP_SILENT_ACTION,
  type NameDropAuditKey,
} from "../agent/channels/name-drop-wake-audit.js";
import { CONSEQUENTIAL_AUDIT_ACTIONS } from "../agent/audit/action-registry.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("name-drop-wake-audit");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const KEY: NameDropAuditKey = {
  org: "acme",
  platform: "slack",
  workspace: "T0EXAMPLE",
  surface: "C0EXCHAN003",
  principalId: "U123",
  container: "C0EXCHAN003",
  ts: "1757854280.000100",
};

type Row = { readonly action: string; readonly detail: Readonly<Record<string, unknown>>; readonly [k: string]: unknown };

function collector(): { rows: Row[]; append: (e: Row) => Promise<void> } {
  const rows: Row[] = [];
  return { rows, append: async (e) => void rows.push(e) };
}

const declared = (action: string) => CONSEQUENTIAL_AUDIT_ACTIONS.find((d) => d.action === action);

{
  const woke = declared(NAME_DROP_WOKE_ACTION);
  const silent = declared(NAME_DROP_SILENT_ACTION);
  ok(woke !== undefined, `§1 "${NAME_DROP_WOKE_ACTION}" is declared in the CONSEQUENTIAL table`);
  ok(silent !== undefined, `§1 "${NAME_DROP_SILENT_ACTION}" is declared in the CONSEQUENTIAL table`);
  ok((woke?.fields.length ?? 0) > 0, "🔴 §1 the ADMIT row declares its detail fields — an empty list is the OPE-1893 counter-example");
  ok((silent?.fields.length ?? 0) > 0, "🔴 §1 the SILENT row declares its detail fields");
  assert.deepEqual([...(woke?.fields ?? [])].sort(), ["container", "reason", "road", "ts", "via"]);
  passed++;
  assert.deepEqual([...(silent?.fields ?? [])].sort(), ["container", "reason", "ts"]);
  passed++;
  ok(woke?.notExercised === undefined, "§1 the ADMIT row claims no notExercised reason — S9 drives it");
  ok(typeof silent?.notExercised === "string" && silent.notExercised.length > 0, "§1 the SILENT row states WHY no leg drives it");
}

{
  const c = collector();
  await auditNameDropWoke(KEY, "name-dropped in an enabled internal channel — judged wake", { road: "seat", via: "built-in", append: c.append });
  ok(c.rows.length === 1, "§2 the ADMIT emitter writes exactly one row");
  const row = c.rows[0];
  ok(row.action === NAME_DROP_WOKE_ACTION, "§2 …under the declared action name");
  for (const f of declared(NAME_DROP_WOKE_ACTION)?.fields ?? []) {
    ok(Object.hasOwn(row.detail, f), `§2 the ADMIT row's detail carries the declared field "${f}"`);
  }
  ok(row.org === "acme" && row.platform === "slack" && row.workspace === "T0EXAMPLE" && row.surface === "C0EXCHAN003", "§2 …keyed by the caller's partition");
  ok(row.principalId === "U123", "§2 …and naming the member who said the name");
  ok(row.detail.container === "C0EXCHAN003" && row.detail.ts === "1757854280.000100", "§2 …with the room and the message locator a reader joins on");

  const s = collector();
  await auditNameDropSilent(KEY, "nameDropWake not enabled for this channel's domain", { append: s.append });
  ok(s.rows.length === 1 && s.rows[0].action === NAME_DROP_SILENT_ACTION, "§2 the SILENT emitter writes one row under its own action");
  for (const f of declared(NAME_DROP_SILENT_ACTION)?.fields ?? []) {
    ok(Object.hasOwn(s.rows[0].detail, f), `§2 the SILENT row's detail carries the declared field "${f}"`);
  }
  ok(
    s.rows[0].detail.reason === "nameDropWake not enabled for this channel's domain",
    "🔴 §2 …and the reason is the GATE's own words, so an operator reads which gate refused rather than that one did",
  );
}

{
  const c = collector();
  await auditNameDropWoke(KEY, "arm", { road: "native", via: "arm", append: c.append });
  await auditNameDropSilent(KEY, "channel not confirmed internal", { append: c.append });
  ok(c.rows[0].detail.road === "native" && c.rows[0].detail.via === "arm", "§3 the ADMIT row states WHICH session woke and WHO decided");
  ok(!Object.hasOwn(c.rows[1].detail, "road") && !Object.hasOwn(c.rows[1].detail, "via"), "§3 the SILENT row carries neither — nothing woke, so there is no road and no decider");
  ok(c.rows[0].action !== c.rows[1].action, "§3 the two rows are separate actions, so a reader never joins a refusal as an admission");
  const n = collector();
  await auditNameDropSilent({ ...KEY, ts: null }, "no locator", { append: n.append });
  ok(Object.hasOwn(n.rows[0].detail, "ts") && n.rows[0].detail.ts === null, "§3 a surface with no locator writes ts:null — present and explicit, never omitted");
}

{
  const boom = async (): Promise<void> => {
    throw new Error("store down");
  };
  await auditNameDropWoke(KEY, "r", { road: "seat", via: "built-in", append: boom });
  ok(true, "🔴 §4 an ADMIT append that throws does not reach the caller — an observability write never changes a wake");
  await auditNameDropSilent(KEY, "r", { append: boom });
  ok(true, "🔴 §4 …and neither does a SILENT one");
}

{
  const bare = nameDropAuditRow(KEY, NAME_DROP_WOKE_ACTION, "r");
  ok(
    (declared(NAME_DROP_WOKE_ACTION)?.fields ?? []).some((f) => !Object.hasOwn(bare.detail, f)),
    "§5 negative control: a row built WITHOUT the admit extras really is missing a declared field, so §2's loop can fail",
  );
  ok(declared("surface.name_drop_no_such_action") === undefined, "§5 negative control: the declaration lookup answers undefined for an action the registry does not carry");
}

console.log(`✓ name-drop-wake-audit: ${passed} assertions passed`);
