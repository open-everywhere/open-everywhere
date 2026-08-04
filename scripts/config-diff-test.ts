import { buildConfigSnapshot, SNAPSHOT_SECTIONS } from "./config-snapshot-build.js";
import {
  accessSideEffectFindings,
  CONFIG_DIFF_MARKER,
  decodeSet,
  describeEffectiveAccess,
  diffConfigSnapshots,
  digestValue,
  encodeSet,
  flattenEntity,
  MAX_INLINE_VALUE_CHARS,
  NO_CHANGE_LINE,
  NOT_COMPUTABLE_PREFIX,
  renderConfigDiff,
  sectionHasDelta,
  SNAPSHOT_FORMAT_VERSION,
  type ConfigSnapshot,
  type SnapshotRow,
} from "./config-snapshot-diff.js";
import type { EffectiveAccess } from "@open-everywhere/core/agent/access/resolver.js";
import { applyRoleDefaults } from "@open-everywhere/core/agent/roles/role.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const hash = (s: string): string => "h" + String(s.length * 31);

function snap(sections: string[], rows: [string, string, string][], formatVersion = SNAPSHOT_FORMAT_VERSION): ConfigSnapshot {
  return { formatVersion, sections, rows: rows.map(([section, key, value]) => ({ section, key, value })) };
}

ok(encodeSet(["b", "a"]) === encodeSet(["a", "b"]), "encodeSet is order-insensitive (a reordered config array is not a change)");
ok(encodeSet([]) === "[]", "encodeSet of nothing is []");
ok(decodeSet("[a, b]")!.join("|") === "a|b", "decodeSet round-trips encodeSet");
ok(decodeSet("[]")!.length === 0, "decodeSet of [] is empty, not undefined");
ok(decodeSet("plain") === undefined, "decodeSet refuses a non-set value (so renderChange falls back)");

const shortStr = "x".repeat(MAX_INLINE_VALUE_CHARS);
const longStr = "x".repeat(MAX_INLINE_VALUE_CHARS + 1);
ok(digestValue(shortStr, hash) === JSON.stringify(shortStr), "a value at the inline cap stays inline");
ok(digestValue(longStr, hash).startsWith("<") && digestValue(longStr, hash).includes("sha256:"), "a value over the cap is digested");
ok(digestValue(longStr, hash) !== digestValue(longStr + "y", hash), "the digest CHANGES when the prompt text changes (else a prompt edit is invisible)");

{
  const rows = flattenEntity("payments", { name: "payments", bundle: "pay-tools", channels: ["slack/T/C2", "slack/T/C1"] }, hash);
  const m = new Map(rows.map((r) => [r.key, r.value]));
  ok(m.get("payments.bundle") === '"pay-tools"', "flattenEntity emits a scalar field as its own row");
  ok(m.get("payments.channels") === "[slack/T/C1, slack/T/C2]", "a scalar array flattens to ONE order-insensitive set row");
  const withNew = flattenEntity("payments", { name: "payments", somethingAddedTomorrow: true }, hash);
  ok(
    withNew.some((r) => r.key === "payments.somethingAddedTomorrow"),
    "a field NOBODY enumerated is still covered (generic reflection has no field-list blind spot)",
  );
  const objArray = flattenEntity("p", { credentials: [{ id: "b", type: "bearer" }, { id: "a", type: "oauth" }] }, hash);
  ok(objArray.some((r) => r.key === "p.credentials[a].type"), "an array of objects is keyed by the member's own id, not by index");
  ok(!flattenEntity("p", { absent: undefined }, hash).some((r) => r.key === "p.absent"), "an absent optional field emits no row");
  ok(flattenEntity("p", { present: null }, hash).some((r) => r.value === "null"), "an explicitly-null field DOES emit a row (distinguishable from absent)");
}

{
  const fake = {
    reachableHosts: [{ host: "api.notion.com", viaConnection: "notion-rest", methods: ["GET", "POST"] }],
    connections: [{ id: "notion-rest", credentialType: "bearer", allowedWebsites: ["api.notion.com"], methods: ["GET"] }],
    connectors: ["notion"],
    repos: ["acme/app"],
    awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/oe-app", region: "eu-west-2" }],
  } as unknown as EffectiveAccess;
  const d = describeEffectiveAccess(fake);
  ok(d.hosts[0] === "api.notion.com [auth via notion-rest] methods=GET,POST", "hosts carry the auth connection AND the method narrowing");
  ok(d.awsRoles[0] === "arn:aws:iam::123456789012:role/oe-app region=eu-west-2", "awsRoles carry the role ARN + region facet");
  ok(d.connections[0].includes("bearer") && d.connections[0].includes("methods=GET"), "connections carry credential type + method scope");
  ok(d.connectors[0] === "notion" && d.repos[0] === "acme/app", "connectors and repos project verbatim");
}

{
  const after = snap(["access", "domains"], [["access", "slack/T/C · repos", "[a/b]"]]);

  const noBase = diffConfigSnapshots(undefined, after, { baseFailure: "npm ci failed in the base checkout" });
  ok(noBase.sections.length === 2, "a missing base still renders every section of the head snapshot");
  ok(noBase.sections.every((s) => s.kind === "not-computable"), "a missing base makes EVERY section not-computable (never an empty-base green)");
  ok(noBase.sections.every((s) => s.kind === "not-computable" && s.reason.includes("npm ci failed")), "the base failure REASON reaches every section");
  ok(noBase.findings.some((f) => f.id === "base-snapshot-unavailable"), "a missing base raises base-snapshot-unavailable");

  const noReason = diffConfigSnapshots(undefined, after, {});
  ok(
    noReason.sections.every((s) => s.kind === "not-computable" && s.reason.includes("no reason was recorded")),
    "an unexplained missing base is reported as an unexplained unknown, never omitted",
  );

  const oldEncoding = snap(["access", "domains"], [["access", "slack/T/C · repos", "a/b"]], SNAPSHOT_FORMAT_VERSION - 1);
  const ver = diffConfigSnapshots(oldEncoding, after);
  ok(ver.sections.every((s) => s.kind === "not-computable"), "a formatVersion mismatch makes every section not-computable");
  ok(ver.findings.some((f) => f.id === "format-version-mismatch"), "a formatVersion mismatch is a named finding");

  const narrowBase = snap(["access"], [["access", "slack/T/C · repos", "[a/b]"]]);
  const widened = diffConfigSnapshots(narrowBase, after);
  const domainsState = widened.sections.find((s) => s.section === "domains")!;
  ok(domainsState.kind === "not-computable", "a section the base did not DECLARE is not-computable, not 'everything added'");
  ok(domainsState.kind === "not-computable" && domainsState.reason.includes("new coverage"), "the new-coverage reason names why");
  ok(widened.sections.find((s) => s.section === "access")!.kind === "computed", "a section BOTH sides declare is still computed");

  const widerBase = snap(["access", "domains", "webhooks"], []);
  const narrowed = diffConfigSnapshots(widerBase, after);
  const gone = narrowed.sections.find((s) => s.section === "webhooks")!;
  ok(gone.kind === "not-computable", "a section head no longer declares is not-computable");
  ok(narrowed.findings.some((f) => f.id === "coverage-regressed"), "dropped coverage raises coverage-regressed (a gutted dumper is visible)");

  const same = diffConfigSnapshots(after, after);
  ok(same.sections.every((s) => s.kind === "computed"), "identical snapshots compare cleanly");
  ok(same.sections.every((s) => !sectionHasDelta(s)), "identical snapshots carry no delta");
  ok(same.findings.length === 0, "identical snapshots raise no finding");

  const before = snap(["access"], [["access", "k.stays", "1"], ["access", "k.goes", "2"], ["access", "k.moves", "3"]]);
  const nowRows = snap(["access"], [["access", "k.stays", "1"], ["access", "k.moves", "4"], ["access", "k.new", "5"]]);
  const cls = diffConfigSnapshots(before, nowRows).sections[0];
  ok(cls.kind === "computed" && cls.added.length === 1 && cls.added[0].key === "k.new", "a new row is ADDED");
  ok(cls.kind === "computed" && cls.removed.length === 1 && cls.removed[0].key === "k.goes", "a vanished row is REMOVED");
  ok(cls.kind === "computed" && cls.changed.length === 1 && cls.changed[0].before === "3" && cls.changed[0].after === "4", "a moved value is CHANGED with both sides");
}

{
  const b = snap(["access", "roles"], [["access", "slack/T/C · repos", "[]"], ["roles", "qa.bundle", '"a"']]);
  const a = snap(["access", "roles"], [["access", "slack/T/C · repos", "[acme/app]"], ["roles", "qa.bundle", '"coding"']]);
  const d = diffConfigSnapshots(b, a);

  const sideOn = accessSideEffectFindings(d, ["agent/roles/roles.ts"]);
  ok(sideOn.length === 1 && sideOn[0].id === "access-changed-side-on", "access moving with NO agent/access/** edit is the side-on finding");
  ok(sideOn[0].detail.includes("roles"), "the finding names the section the change arrived through");
  ok(sideOn[0].detail.includes("slack/T/C"), "the finding names the affected scope, not just a count");

  const authored = accessSideEffectFindings(d, ["agent/access/bundles.ts"]);
  ok(authored.length === 0, "an EXPLICIT access edit raises no side-on finding (that is the expected path)");

  const unknown = accessSideEffectFindings(d, undefined);
  ok(
    unknown.length === 1 && unknown[0].id === "access-attribution-not-computable",
    "an unknown changed-file set yields a NOT-COMPUTABLE attribution finding, never silence",
  );

  const noAccessMove = accessSideEffectFindings(diffConfigSnapshots(b, b), ["agent/roles/roles.ts"]);
  ok(noAccessMove.length === 0, "no access delta ⇒ no side-on finding (the finding is about access moving, not about editing roles)");

  const blindAccess = diffConfigSnapshots(undefined, a, { baseFailure: "x" });
  ok(
    accessSideEffectFindings(blindAccess, ["agent/roles/roles.ts"]).length === 0,
    "a not-computable access section raises no side-on finding (it is already reported as unknown — never double-report an unknown as a delta)",
  );
}

{
  const before = snap(["access", "roles", "silos"], [["access", "k", "[]"], ["roles", "qa.bundle", '"a"']]);
  const after = snap(["access", "roles", "webhooks"], [["access", "k", "[acme/app]"], ["roles", "qa.bundle", '"a"']]);
  const d = diffConfigSnapshots(before, after);
  const md = renderConfigDiff({ ...d, findings: [...d.findings, ...accessSideEffectFindings(d, ["agent/roles/roles.ts"])] }, {
    baseRef: "origin/main",
    headRef: "HEAD",
    changedFiles: ["agent/roles/roles.ts"],
  });

  ok(md.startsWith(CONFIG_DIFF_MARKER), "the report starts with the stable marker CI matches its own comment on");

  for (const s of d.sections) {
    const heading = `### \`${s.section}\``;
    ok(md.split(heading).length === 2, `section ${s.section} renders exactly once`);
    const body = md.split(heading)[1].split("###")[0];
    const states = [body.includes(NOT_COMPUTABLE_PREFIX), body.includes(NO_CHANGE_LINE), body.includes("```diff")].filter(Boolean);
    ok(states.length === 1, `section ${s.section} renders EXACTLY ONE of computed/not-computable/delta (got ${states.length})`);
    if (s.kind === "not-computable") ok(body.includes(NOT_COMPUTABLE_PREFIX), `not-computable section ${s.section} renders as NOT COMPUTABLE`);
    if (s.kind === "computed" && !sectionHasDelta(s)) ok(body.includes(NO_CHANGE_LINE), `unchanged section ${s.section} says it was COMPUTED`);
    if (s.kind === "not-computable") ok(!body.includes(NO_CHANGE_LINE), `not-computable section ${s.section} NEVER renders the no-change green`);
  }

  ok(md.includes("could not be compared"), "the HEADLINE warns when any section was not comparable");
  ok(md.includes("access-changed-side-on"), "findings are rendered by id so a reviewer can name one");
  ok(md.includes("+ k: acme/app"), "a set-valued change renders item-level, so the ONE gained host is visible");
  ok(!md.includes("- k: acme/app"), "an item-level change does not also print the whole before-list as removed");

  const blind = diffConfigSnapshots(undefined, after, { baseFailure: "the base checkout had no node_modules" });
  const blindMd = renderConfigDiff(blind, { changedFiles: [] });
  ok(blindMd.includes("establishes NOTHING"), "a fully-blind report says so in the summary line");
  ok(!blindMd.includes(NO_CHANGE_LINE), "a fully-blind report contains NO no-change green anywhere");

  const noFiles = renderConfigDiff(diffConfigSnapshots(after, after), {});
  ok(noFiles.includes(NOT_COMPUTABLE_PREFIX) && noFiles.includes("files this PR touches could not be determined"), "an unknown file set is rendered as NOT COMPUTABLE");
  ok(renderConfigDiff(diffConfigSnapshots(after, after), { changedFiles: [] }).includes("(none reported)"), "an EMPTY file set is distinguishable from an unknown one");
}

{
  const live = buildConfigSnapshot();
  ok(live.formatVersion === SNAPSHOT_FORMAT_VERSION, "the live snapshot stamps the current format version");
  ok(live.rows.length > 100, `the live snapshot is substantial (${live.rows.length} rows)`);

  ok(JSON.stringify(live) === JSON.stringify(buildConfigSnapshot()), "two builds of the same tree are byte-identical (no clock, no random, no key-order drift)");

  const keys = live.rows.map((r) => `${r.section} ${r.key}`);
  ok(new Set(keys).size === keys.length, "every (section,key) is unique — no row shadows another");
  ok(JSON.stringify(keys) === JSON.stringify([...keys].sort((a, b) => a.localeCompare(b))), "rows are emitted in sorted order");

  const declared = new Set(live.sections);
  ok(SNAPSHOT_SECTIONS.every((s) => declared.has(s)), "every SNAPSHOT_SECTIONS entry is declared in the snapshot");
  ok(live.rows.every((r) => declared.has(r.section)), "no row belongs to an UNDECLARED section (such a row would be undiffable)");

  for (const s of ["access", "domains", "bundles", "bindings", "providers", "roles", "mounted", "plugins"]) {
    ok(live.rows.some((r) => r.section === s), `section "${s}" carries rows in the live config`);
  }
  ok(
    live.rows.some((r) => r.section === "plugins" && r.key.endsWith(".skills")),
    "a plugin's skill expansion is a row (so a plugin edit is attributable, not just felt in `access`)",
  );
  ok(declared.has("principals"), "an empty section is still DECLARED (empty ≠ uncovered)");

  const mounted = live.rows.filter((r) => r.section === "mounted");
  ok(mounted.some((r) => r.key === "tools/bash.ts" && r.value.startsWith("disabled")), "a disableTool() sentinel is classified DISABLED, not mounted");
  ok(mounted.some((r) => r.key.startsWith("tools/") && r.value === "mounted"), "a real tool file is classified MOUNTED");
  ok(mounted.some((r) => r.key === "tools/"), "the tool directory's own roster size is a row (a bulk add is one visible delta)");

  ok(live.rows.some((r) => r.section === "access" && r.key.includes(" · hosts")), "access rows carry the ` · <facet>` key grammar the finding parses");

  const secretish = Object.entries(process.env).filter(
    ([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL/i.test(k) && typeof v === "string" && v.length >= 12,
  );
  const serialised = JSON.stringify(live);
  const leaked = secretish.filter(([, v]) => serialised.includes(v!));
  ok(leaked.length === 0, `no secret-shaped env value appears in the snapshot (would have leaked: ${leaked.map(([k]) => k).join(", ")})`);
  ok(secretish.length > 0 || process.env.CI !== undefined, "the leak check had something to look for (or is running in secret-free CI)");

  const selfDiff = diffConfigSnapshots(live, live);
  ok(selfDiff.sections.length === live.sections.length, "self-diff renders every declared section");
  ok(selfDiff.sections.every((s) => s.kind === "computed" && !sectionHasDelta(s)), "self-diff is fully computed with zero deltas");
  ok(accessSideEffectFindings(selfDiff, []).length === 0, "self-diff raises no side-on finding");
}

{
  const roles = [{ name: "engineer", memory: "eng-brain", sandbox: { vcpus: 4 } }];
  const raw = [
    { name: "eng", channels: ["slack/T/C1"], role: "engineer" },
    { name: "ops", channels: ["slack/T/C2"], role: "engineer", memory: "own-brain" },
  ];
  const resolved = applyRoleDefaults(raw as never, roles as never);

  const engRows = new Map(flattenEntity("eng", resolved[0], hash).map((r) => [r.key, r.value]));
  ok(engRows.get("eng.memory") === '"eng-brain"', "a role-SUPPLIED memory silo appears in the snapshot (the diff sees a role re-point) — and `memory` IS read downstream, so it is a real data-access change");
  ok(engRows.get("eng.sandbox.vcpus") === "4", "a role-supplied sandbox preset appears, nested");
  ok(![...engRows.keys()].some((k) => k.endsWith(".bundle")), "a resolved domain carries NO bundle row — a role has no capability field to supply, so `access` can never move behind one");

  const opsRows = new Map(flattenEntity("ops", resolved[1], hash).map((r) => [r.key, r.value]));
  ok(opsRows.get("ops.memory") === '"own-brain"', "the domain's OWN value still wins over the role's (the snapshot shows what resolves, not what was declared)");

  const repointed = applyRoleDefaults(raw as never, [{ ...roles[0], memory: "infra-brain" }] as never);
  const before = snap(["domains"], flattenEntity("eng", resolved[0], hash).map((r) => ["domains", r.key, r.value] as [string, string, string]));
  const after = snap(["domains"], flattenEntity("eng", repointed[0], hash).map((r) => ["domains", r.key, r.value] as [string, string, string]));
  const rolePointDiff = diffConfigSnapshots(before, after).sections[0];
  ok(
    rolePointDiff.kind === "computed" && rolePointDiff.changed.some((c) => c.key === "eng.memory" && c.after === '"infra-brain"'),
    "re-pointing the ROLE alone moves the DOMAIN's resolved memory row — the OPE-255 mechanism, pinned",
  );
}

const pin: SnapshotRow = { section: "access", key: "k", value: "v" };
ok(pin.section === "access", "SnapshotRow keeps its three-field shape");

console.log(`✓ config-diff: ${passed} assertions passed (three-state honesty, generic reflection, side-on finding, live determinism + no-secret)`);
