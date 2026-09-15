import assert from "node:assert/strict";
import {
  formatMemoryDelta,
  selectChangedSilos,
  renderMemoryDelta,
  sessionReadSilos,
  selectIndexChanges,
  formatIndexDelta,
  renderIndexDelta,
  type MemoryDeltaSilo,
  type RenderMemoryDeltaOpts,
} from "../agent/memory/wake-delta.js";
import { siloTier } from "../agent/memory/store.js";
import { memoryRecallRouteFor } from "../agent/access/window-gate-manifest.js";
import type { AuditEntry } from "../agent/audit/audit.js";
import { defineDomain } from "../agent/memory/domain.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("wake-delta");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SILOS: MemoryDeltaSilo[] = [
  { tier: siloTier("acme-eng"), siloName: "acme-eng" },
  { tier: siloTier("handbook"), siloName: "handbook" },
];

function row(over: { ts: string; silo?: string; version?: string; sessionId?: string; continuationToken?: string }): AuditEntry {
  const { ts, silo, version, sessionId, continuationToken } = over;
  return {
    ts,
    org: "acme",
    platform: "notion",
    workspace: "W1",
    action: "memory.write",
    detail: {
      ...(silo ? { silo } : {}),
      ...(version ? { version } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(continuationToken ? { continuationToken } : {}),
      files: 3,
    },
  };
}

const CURSOR = "2026-07-13T10:00:00.000Z";
const AT = "2026-07-13T10:05:00.000Z";
const base: RenderMemoryDeltaOpts = { org: "acme", silos: SILOS, sinceIso: CURSOR };

ok(formatMemoryDelta([]) === null, "formatter: empty pointer list → null (nothing changed)");
{
  const s = formatMemoryDelta([
    { path: "memory/acme-eng", siloName: "acme-eng", writes: 1 },
    { path: "memory/handbook", siloName: "handbook", writes: 2, latestVersion: "abc123" },
  ]);
  ok(s !== null, "formatter: pointers → a block");
  ok(s!.startsWith("<system-reminder>") && s!.endsWith("</system-reminder>"), "formatter: the block is a fully-formed <system-reminder> tag");
  ok(s!.includes("- memory/acme-eng — silo \"acme-eng\" (updated)"), "formatter: a single-write silo renders '(updated)'");
  ok(s!.includes("- memory/handbook — silo \"handbook\" (updated 2×)"), "formatter: a multi-write silo renders the count");
  ok(s!.includes("ONLY if it bears on the current message"), "formatter: carries the 'use only if relevant' hygiene line");
  ok(!s!.includes("files: 3") && !s!.includes("<untrusted"), "formatter: no audit-internal / untrusted content leaks into the block");
}

{
  const ptrs = [{ path: "memory/acme-eng", siloName: "acme-eng", writes: 1 }];
  const content = (r: Parameters<typeof formatMemoryDelta>[1]) => formatMemoryDelta(ptrs, r)!;
  const index = (r: Parameters<typeof formatIndexDelta>[1]) => formatIndexDelta({ healed: ["acme-eng"] }, r)!;

  ok(content("file-tools").includes("re-read a path with your file tools"), "delta route file-tools: names the file tools");
  ok(index("file-tools").includes("re-read the relevant path"), "index-delta route file-tools: names a plain re-read");

  for (const [route, verb] of [["agent", "`agent`"]] as const) {
    const c = content(route);
    const i = index(route);
    ok(c.includes("this seat has no file tools") && c.includes(verb), `delta route ${route}: disowns the file tools and names ${verb}`);
    ok(i.includes("this seat has no file tools") && i.includes(verb), `index-delta route ${route}: disowns the file tools and names ${verb}`);
    ok(!c.includes("your file tools") && !i.includes("your file tools"), `delta route ${route}: never claims the seat HAS file tools`);
  }

  const none = content("none");
  ok(none.includes("CANNOT open these files") && none.includes("say you can't check memory"), "delta route none: refuses rather than inviting a bluff");
  ok(!none.includes("delegate a lookup"), "delta route none: does not name a delegation verb the seat lacks");

  ok(content(undefined) === content(memoryRecallRouteFor("standing")), "delta default: is the STANDING seat's route, not file-tools-by-assumption");
  ok(index(undefined) === index(memoryRecallRouteFor("standing")), "index-delta default: is the STANDING seat's route");
  ok(!content(undefined).includes("your file tools"), "delta default: a standing seat is never told it holds file tools");
}

{
  const rows: AuditEntry[] = [
    row({ ts: "2026-07-13T10:04:00.000Z", silo: "acme-eng", version: "v2" }),
    row({ ts: "2026-07-13T10:03:00.000Z", silo: "acme-eng", version: "v1" }),
    row({ ts: "2026-07-13T10:02:00.000Z", silo: "handbook", version: "h1" }),
  ];
  const ptrs = selectChangedSilos(rows, base);
  ok(ptrs.length === 2, "selector: two distinct silos changed");
  const eng = ptrs.find((p) => p.siloName === "acme-eng")!;
  ok(eng.writes === 2, "selector: dedupes by silo, counting the writes");
  ok(eng.latestVersion === "v2" && eng.path === "memory/acme-eng", "selector: keeps the NEWEST version (rows arrive newest-first) + the sandbox grep path");
  ok(ptrs[0]!.siloName === "acme-eng", "selector: newest-changed silo sorts first");
}
{
  const ptrs = selectChangedSilos([row({ ts: "2026-07-13T10:04:00.000Z", silo: "payments-other" })], base);
  ok(ptrs.length === 0, "selector: a write to a silo this session does NOT read is filtered out");
}
{
  const ptrs = selectChangedSilos([row({ ts: CURSOR, silo: "acme-eng" })], base);
  ok(ptrs.length === 0, "selector: a row exactly AT the cursor is excluded (strictly-after)");
}
{
  const ptrs = selectChangedSilos([row({ ts: "2026-07-13T10:06:00.000Z", silo: "acme-eng" })], { ...base, atIso: AT });
  ok(ptrs.length === 0, "selector: a row after atIso (this dispatch) is excluded");
}
{
  const rows: AuditEntry[] = [
    row({ ts: "2026-07-13T10:04:00.000Z", silo: "acme-eng", continuationToken: "oe-dom:eng:oe-sup:g3" }),
    row({ ts: "2026-07-13T10:03:30.000Z", silo: "handbook", sessionId: "oe-dom:eng:oe-sup:g3" }),
    row({ ts: "2026-07-13T10:03:00.000Z", silo: "acme-eng", continuationToken: "someone-else:oe-sup:g1" }),
  ];
  const ptrs = selectChangedSilos(rows, { ...base, selfKey: "oe-dom:eng:oe-sup:g3" });
  ok(ptrs.length === 1 && ptrs[0]!.siloName === "acme-eng" && ptrs[0]!.writes === 1, "selector: excludes the session's OWN writes (continuationToken OR sessionId match), keeps another session's");
}

{
  const stubRead = async () => [row({ ts: "2026-07-13T10:04:00.000Z", silo: "acme-eng", version: "v2" })];
  const s = await renderMemoryDelta({ ...base, atIso: AT, readAudit: stubRead });
  ok(s !== null && s.includes("memory/acme-eng"), "renderMemoryDelta: names the changed silo via the injected audit reader");
}
{
  const s = await renderMemoryDelta({ ...base, readAudit: async () => [] });
  ok(s === null, "renderMemoryDelta: no rows → null (nothing to push)");
}
{
  const s = await renderMemoryDelta({ ...base, silos: [], readAudit: async () => [row({ ts: AT, silo: "acme-eng" })] });
  ok(s === null, "renderMemoryDelta: a session that reads NO silos → null (never any delta)");
}
{
  const s = await renderMemoryDelta({ ...base, readAudit: async () => { throw new Error("audit down"); } });
  ok(s === null, "renderMemoryDelta: a failing audit read fails SOFT to null (never throws into the wake)");
}

{
  const eng = defineDomain({ name: "eng", reach: ["linear/org/team-1"], memory: ["acme-eng", "handbook"], ambientSupervisor: true, mode: "unified" });
  const orgD = defineDomain({ name: "org", match: "org", memory: "org-baseline" });
  const silos = sessionReadSilos("linear/org/team-1", [eng, orgD]);
  ok(silos.length === 2 && silos.some((s) => s.siloName === "acme-eng") && silos.some((s) => s.siloName === "handbook"), "sessionReadSilos: an explicit domain resolves its own memory silos");
  const engInclOrg = defineDomain({ name: "eng", reach: ["linear/org/team-1"], memory: "acme-eng", includeOrg: "readonly" });
  const withOrg = sessionReadSilos("linear/org/team-1", [engInclOrg, orgD]);
  ok(withOrg.some((s) => s.siloName === "org-baseline"), "sessionReadSilos: includeOrg pulls the org pseudo-domain's silos");
  ok(sessionReadSilos("linear/org/unassigned", [orgD]).some((s) => s.siloName === "org-baseline"), "sessionReadSilos: an unassigned surface falls back to the org default silos");
  ok(sessionReadSilos("linear/org/team-1", [defineDomain({ name: "eng", reach: ["linear/org/team-1"] })]).length === 0, "sessionReadSilos: a memory-less domain resolves no silos");
}

function indexRow(over: { ts: string; healed?: string[]; continuationToken?: string }): AuditEntry {
  const { ts, healed, continuationToken } = over;
  return {
    ts,
    org: "acme",
    platform: "notion",
    workspace: "W1",
    action: "memory.index_change",
    detail: { ...(healed ? { healed } : {}), ...(continuationToken ? { continuationToken } : {}) },
  };
}

ok(formatIndexDelta({ healed: [] }) === null, "index formatter: no healed silos → null");
{
  const s = formatIndexDelta({ healed: ["handbook"] });
  ok(s !== null && s.startsWith("<system-reminder>") && s.endsWith("</system-reminder>"), "index formatter: a healed silo → a fully-formed <system-reminder>");
  ok(s!.includes("\"handbook\"") && s!.includes("/workspace/memory/MEMORY.md"), "index formatter: names the healed silo + points at the refreshed on-disk index");
  ok(!s!.includes("<untrusted"), "index formatter: silo NAMES only — no content / untrusted-wrap (the taint rule)");
}

const SELF = "oe-dom:eng:oe-sup:g3";
{
  const rows: AuditEntry[] = [
    indexRow({ ts: "2026-07-13T10:04:00.000Z", healed: ["handbook"], continuationToken: SELF }),
    indexRow({ ts: "2026-07-13T10:03:00.000Z", healed: ["acme-eng"], continuationToken: SELF }),
  ];
  const c = selectIndexChanges(rows, { org: "acme", sinceIso: CURSOR, selfKey: SELF });
  ok(c.healed.length === 2 && c.healed.includes("handbook") && c.healed.includes("acme-eng"), "index selector: aggregates healed silo names from this session's rows");
}
{
  ok(selectIndexChanges([indexRow({ ts: CURSOR, healed: ["handbook"], continuationToken: SELF })], { org: "acme", sinceIso: CURSOR, selfKey: SELF }).healed.length === 0, "index selector: a row exactly AT the cursor is excluded (strictly-after) — fires once per change, not every turn");
}
{
  ok(selectIndexChanges([indexRow({ ts: "2026-07-13T10:06:00.000Z", healed: ["handbook"], continuationToken: SELF })], { org: "acme", sinceIso: CURSOR, atIso: AT, selfKey: SELF }).healed.length === 0, "index selector: a row after atIso (this dispatch) is excluded");
}
{
  ok(selectIndexChanges([indexRow({ ts: "2026-07-13T10:04:00.000Z", healed: ["handbook"], continuationToken: "other:oe-sup:g1" })], { org: "acme", sinceIso: CURSOR, selfKey: SELF }).healed.length === 0, "index selector: only THIS session's plan changes are surfaced (selfKey match, not exclude)");
}

{
  const s = await renderIndexDelta({ org: "acme", sinceIso: CURSOR, atIso: AT, selfKey: SELF, readAudit: async () => [indexRow({ ts: "2026-07-13T10:04:00.000Z", healed: ["handbook"], continuationToken: SELF })] });
  ok(s !== null && s.includes("\"handbook\""), "renderIndexDelta: names the healed silo via the injected audit reader");
}
{
  ok((await renderIndexDelta({ org: "acme", sinceIso: CURSOR, selfKey: SELF, readAudit: async () => [] })) === null, "renderIndexDelta: no rows → null");
  ok((await renderIndexDelta({ org: "acme", sinceIso: CURSOR, selfKey: SELF, readAudit: async () => { throw new Error("audit down"); } })) === null, "renderIndexDelta: a failing audit read fails SOFT to null");
}

assert.ok(passed > 0);
console.log(`\n✓ wake-delta: ${passed} assertions passed`);
