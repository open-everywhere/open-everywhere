import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { EVE_EVENT_NAMES, EVE_EVENT_NAMES_PIN } from "./eve-event-names.generated.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TABLE_FILE = "scripts/eve-event-names.generated.ts";
const SELF = "scripts/eve-event-names-lint.ts";
const DRIFT_FILE = "scripts/eve-event-names-drift.ts";

export const BASELINE_0_71_0: readonly string[] = Object.freeze([
  "action.input.appended", "action.partial", "action.result", "actions.requested", "agent.started",
  "approval.candidate", "approval.settled", "authorization.completed", "authorization.required",
  "compaction.completed", "compaction.requested", "context.cleared", "input.requested", "input.resolved",
  "message.appended", "message.completed", "message.received", "reasoning.appended", "reasoning.completed",
  "result.completed", "session.completed", "session.failed", "session.started", "session.waiting",
  "step.completed", "step.failed", "step.started", "task.settled", "task.started", "turn.cancelled",
  "turn.completed", "turn.failed", "turn.started", "turn.waiting",
]);

export const NOT_EVE_EVENTS: readonly { readonly file: string; readonly name: string; readonly why: string }[] = [
  { file: "packages/core/agent/channels/turn-cancel.ts", name: "turn.cancelled", why: "OE's own audit action TURN_CANCELLED_ACTION; renaming it breaks audit history" },
  { file: "packages/core/agent/audit/action-registry.ts", name: "turn.cancelled", why: "the registry row for OE's turn.cancelled audit action" },
  { file: "packages/core/scripts/e2e/scenarios.ts", name: "turn.cancelled", why: "an audit read of OE's own turn.cancelled action (TURN_CANCELLED_ACTION)" },
  { file: "packages/core/agent/channels/work.ts", name: "task.settled", why: "OE's postOnce dedupe-key namespace for a work result; renaming it re-posts results already posted inside the TTL" },
  { file: "packages/providers/slack/agent/channels/slack.ts", name: "turn.failed", why: "the surface.quiet_fail audit row's event label; renaming it splits audit history and drops the failure meaning" },
  { file: "packages/providers/slack/agent/channels/slack.ts", name: "session.failed", why: "the surface.quiet_fail audit row's event label; renaming it splits audit history and drops the failure meaning" },
  { file: "packages/core/scripts/dream-mode3-test.ts", name: "turn.failed", why: "fixtures of the surface.quiet_fail audit row, whose event label slack.ts writes (the row above)" },
  { file: "packages/providers/email/agent/provider-events.ts", name: "message.received", why: "AgentMail's webhook event name (docs.agentmail.to), the vendor's word" },
  { file: "packages/providers/email/agent/transports/agentmail.ts", name: "message.received", why: "AgentMail's webhook event name, matched on the inbound payload" },
  { file: "packages/providers/email/scripts/email-agentmail-test.ts", name: "message.received", why: "AgentMail webhook fixtures" },
  { file: "tests/integration/ingress/email-signed-delivery.test.ts", name: "message.received", why: "an AgentMail webhook delivery body (`event_type`)" },
];

function exempt(file: string, name: string): boolean {
  return NOT_EVE_EVENTS.some((row) => row.file === file && row.name === name);
}

export function staleExemptions(read: (file: string) => string | undefined): string[] {
  return NOT_EVE_EVENTS.filter((row) => !(read(row.file) ?? "").includes(JSON.stringify(row.name))).map((row) => `${row.file} "${row.name}"`);
}

export function eveEventNames(eveRoot: string): { version: string; names: string[] } {
  const root = resolve(eveRoot);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
    exports: Record<string, string | { types?: string }>;
  };
  const entry = pkg.exports["./hooks"];
  const types = typeof entry === "string" ? entry : entry?.types;
  if (types === undefined) throw new Error(`eve at ${root} exports no "./hooks" types entry`);
  const dir = mkdtempSync(join(tmpdir(), "oe-eve-event-names-"));
  try {
    const target = JSON.stringify(join(root, types).replace(/\.d\.ts$/, ".js"));
    writeFileSync(join(dir, "probe.mts"), `import type { HookEventType } from ${target};\nexport const probe: { [K in HookEventType]: 0 } = 0;\n`);
    const tsc = join(ROOT, "node_modules", ".bin", "tsc");
    const args = ["--noEmit", "--strict", "--skipLibCheck", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--noErrorTruncation", "--types", "", "probe.mts"];
    let out = "";
    try {
      out = execFileSync(tsc, args, { cwd: dir, encoding: "utf8" });
    } catch (err) {
      out = String((err as { stdout?: unknown }).stdout ?? "");
    }
    const names = [...new Set([...out.matchAll(/"([a-z][a-z_]*(?:\.[a-z][a-z_]*)+)": 0/g)].map((m) => m[1]!))].sort();
    if (names.length < 5 || !/TS2322/.test(out)) {
      throw new Error(`eve at ${root}: the HookEventType probe printed ${names.length} names — it did not see the contract:\n${out.slice(0, 600)}`);
    }
    return { version: pkg.version, names };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderTable(version: string, names: readonly string[]): string {
  return [
    `// GENERATED by \`npm run lint:eve-event-names -- --write\` from the installed eve's \`HookEventType\``,
    `// (\`eve/hooks\`). DO NOT EDIT. \`npm run lint:eve-event-names\` refuses a table that the installed eve`,
    `// does not match, and every event-name literal outside it (OPE-2685). \`${DRIFT_FILE}\` refuses the same`,
    `// drift at \`typecheck\`.`,
    ``,
    `export const EVE_EVENT_NAMES_PIN = ${JSON.stringify(version)};`,
    ``,
    `export const EVE_EVENT_NAMES = [`,
    ...names.map((n) => `  ${JSON.stringify(n)},`),
    `] as const;`,
    ``,
  ].join("\n");
}

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly position: string;
}

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly [key: string]: unknown;
}

const EQUALITY = new Set(["===", "!==", "==", "!="]);

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function stringValue(node: AstNode): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    const quasi = (node.quasis as { value: { cooked: string | null } }[])[0];
    return quasi?.value.cooked ?? undefined;
  }
  return undefined;
}

function isTypeDiscriminator(node: AstNode | undefined): boolean {
  if (node === undefined) return false;
  if (node.type === "MemberExpression" && node.computed === false) {
    const name = (node.property as { name?: string }).name;
    return name === "type" || name === "eventType";
  }
  if (node.type === "Identifier") return node.name === "type" || node.name === "eventType";
  return false;
}

function isFunction(node: unknown): boolean {
  return isNode(node) && (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression");
}

function consumerPosition(node: AstNode, chain: readonly AstNode[]): string | undefined {
  const parent = chain[0];
  if (parent === undefined) return undefined;
  if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node) {
    if (parent.type === "MethodDefinition" || parent.method === true || isFunction(parent.value)) return "handler key";
  }
  if (parent.type === "MemberExpression" && parent.computed === true && parent.property === node) return "element access";
  if (parent.type === "BinaryExpression" && EQUALITY.has(parent.operator as string)) {
    if (isTypeDiscriminator((parent.left === node ? parent.right : parent.left) as AstNode)) return "type comparison";
  }
  if (parent.type === "SwitchCase" && parent.test === node && isTypeDiscriminator((chain[1] as AstNode | undefined)?.discriminant as AstNode)) {
    return "switch case";
  }
  if (parent.type === "TSLiteralType") {
    let i = 1;
    let outer: AstNode = parent;
    while (chain[i]?.type === "TSUnionType") outer = chain[i++]!;
    const holder = chain[i];
    if (holder?.type === "TSIndexedAccessType" && holder.indexType === outer) return "type index";
    if (holder?.type === "TSTypeParameterInstantiation" && chain[i + 1]?.type === "TSTypeReference") return "type argument";
    if (holder?.type === "TSTypeAnnotation" && chain[i + 1]?.type === "TSPropertySignature") {
      const key = (chain[i + 1]!.key as { name?: string }).name;
      if (key === "type") return "type discriminator";
    }
  }
  return undefined;
}

const EVENT_SHAPE = /^([a-z]+)\.[a-z][a-z_]*(\.[a-z][a-z_]*)*$/;

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function scanSource(file: string, text: string, known: ReadonlySet<string>, families: ReadonlySet<string>): Finding[] {
  const parsed = parseSync(file, text) as unknown as { program: AstNode; errors: readonly { message: string }[] };
  if (parsed.errors.length > 0 && (parsed.program.body as unknown[]).length === 0) {
    return [{ file, line: 1, name: "<parse error>", position: parsed.errors[0]!.message }];
  }
  const baseline = new Set(BASELINE_0_71_0);
  const findings: Finding[] = [];
  const chain: AstNode[] = [];
  const visit = (node: AstNode): void => {
    const name = stringValue(node);
    if (name !== undefined) {
      const shape = EVENT_SHAPE.exec(name);
      if (shape !== null && !known.has(name)) {
        const rule1 = baseline.has(name) && !exempt(file, name);
        const position = rule1 ? "baseline name" : families.has(shape[1]!) ? consumerPosition(node, chain) : undefined;
        if (position !== undefined) findings.push({ file, line: lineAt(text, node.start), name, position });
      }
    }
    chain.unshift(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" && typeof value === "string") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item);
      } else if (isNode(value)) {
        visit(value);
      }
    }
    chain.shift();
  };
  visit(parsed.program);
  return findings;
}

export function sliceOf(file: string): string {
  if (file.startsWith("packages/core/agent/hooks/")) return "OPE-2692 (hooks)";
  if (file.startsWith("packages/core/agent/channels/") || file.startsWith("packages/providers/") || file.startsWith("packages/adapters/")) {
    return "OPE-2693 (channels, providers, adapters)";
  }
  if (file.startsWith("tests/integration/") || /^packages\/core\/agent\/model\/scripted/.test(file)) return "OPE-2695 (integration tier, scripted model)";
  return "OPE-2694 (rest of core, root agent/)";
}

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((f) => SOURCE_FILE.test(f) && !f.endsWith(".d.ts"))
    .filter((f) => !f.includes("/docs/generated/") && !f.includes("node_modules/"))
    .filter((f) => f !== SELF && f !== TABLE_FILE && f !== DRIFT_FILE);
}

function familyPrefilter(families: ReadonlySet<string>): RegExp {
  return new RegExp(`\\b(${[...families].join("|")})\\.[a-z]`);
}

export function scanTree(known: ReadonlySet<string>): Finding[] {
  const families = familiesOf(known);
  const prefilter = familyPrefilter(families);
  const findings: Finding[] = [];
  for (const file of trackedSources()) {
    const abs = join(ROOT, file);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    if (!prefilter.test(text)) continue;
    findings.push(...scanSource(file, text, known, families));
  }
  return findings;
}

export function familiesOf(known: ReadonlySet<string>): Set<string> {
  return new Set([...BASELINE_0_71_0, ...known].map((n) => n.split(".")[0]!));
}

function report(findings: readonly Finding[]): string {
  const bySlice = new Map<string, Finding[]>();
  for (const f of findings) {
    const slice = sliceOf(f.file);
    bySlice.set(slice, [...(bySlice.get(slice) ?? []), f]);
  }
  const lines: string[] = [];
  for (const [slice, list] of [...bySlice].sort(([a], [b]) => a.localeCompare(b))) {
    const files = new Set(list.map((f) => f.file));
    lines.push(`  ${slice}: ${list.length} literal(s) in ${files.size} file(s)`);
    for (const f of list) lines.push(`    ${f.file}:${f.line}  "${f.name}"  (${f.position})`);
  }
  return lines.join("\n");
}

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function tier1(): void {
  const known = new Set(BASELINE_0_71_0);
  const families = familiesOf(known);
  const scan = (text: string, file = "packages/core/agent/hooks/fixture.ts"): Finding[] => scanSource(file, text, known, families);

  const positions: Record<string, string> = {
    "handler key": `defineHook({ events: { "turn.complete": async () => {} } });`,
    "handler key (method)": `const h = { "turn.complete"(e: unknown) { return e; } };`,
    "element access": `const fn = adapter["turn.complete"];`,
    "type comparison": `if (event.type === "task.ended") { /* */ }`,
    "type comparison (reversed)": `if ("task.ended" !== e.type) { /* */ }`,
    "switch case": `switch (event.type) { case "agent.opened": break; }`,
    "type index": `type H = ChannelEvents<void>["turn.settled"];`,
    "type argument": `type E = ProtocolEvent<"turn.settled" | "turn.started">;`,
  };
  for (const [label, text] of Object.entries(positions)) {
    const got = scan(text);
    ok(got.length === 1 && got[0]!.file === "packages/core/agent/hooks/fixture.ts", `tier 1: a ${label} with an unknown event name is refused`);
  }

  const bumped = new Set(BASELINE_0_71_0.filter((n) => n !== "turn.completed"));
  const filterList = `const ENDS = new Set(["turn.completed", "turn.started"]);`;
  const afterBump = scanSource("x.ts", filterList, bumped, familiesOf(bumped));
  ok(afterBump.length === 1 && afterBump[0]!.name === "turn.completed" && afterBump[0]!.position === "baseline name", "tier 1: a filter list that names a removed event is refused after the bump");
  ok(scan(filterList).length === 0, "tier 1: …and passes while the table still holds it");

  const exemptRow = NOT_EVE_EVENTS[0]!;
  const auditAction = `export const TURN_CANCELLED_ACTION = ${JSON.stringify(exemptRow.name)};`;
  const noTurnCancelled = new Set(BASELINE_0_71_0.filter((n) => n !== exemptRow.name));
  ok(scanSource(exemptRow.file, auditAction, noTurnCancelled, familiesOf(noTurnCancelled)).length === 0, "tier 1 control: an exempt OE audit action passes rule 1 after the bump");
  ok(scanSource("packages/core/agent/other.ts", auditAction, noTurnCancelled, familiesOf(noTurnCancelled)).length === 1, "tier 1: the same literal in a file with no row is still refused");
  ok(
    scanSource(exemptRow.file, `defineHook({ events: { "turn.cancel": async () => {} } });`, noTurnCancelled, familiesOf(noTurnCancelled)).length === 1,
    "tier 1: an exempt file still has rule 2 (a handler key for a missing event is refused)",
  );
  ok(staleExemptions(() => "nothing here").length === NOT_EVE_EVENTS.length, "tier 1: an exemption row whose file lost the literal is refused");

  ok(scan(`defineHook({ events: { "turn.completed": async () => {} } });`).length === 0, "tier 1 control: a known name in a handler key passes");
  ok(scan(`// the consumer reads "turn.complete" and "task.ended" here\nconst x = 1;`).length === 0, "tier 1 control: an event-like name in a comment is not code");
  ok(scan(`/** On v27 this becomes \`turn.settled\` ("turn.settled"). */\nexport const y = 2;`).length === 0, "tier 1 control: an event-like name in a JSDoc is not code");
  ok(
    scan(`appendAudit({ action: "approval.requested" }); if (row.action === "turn.bare_stop") {} const A = ["turn.tool_gated"];`).length === 0,
    "tier 1 control: OE's own audit action names, as values, `.action` comparisons and list members, pass",
  );
  ok(scan(`const DOC = "On v27, \\"turn.complete\\" is renamed.";`).length === 0, "tier 1 control: an event-like name inside a prose string passes");
  ok(scan(`const cfg = { "telemetry.enabled": () => true };`).length === 0, "tier 1 control: a dotted key outside eve's families passes");

  ok(sliceOf("packages/core/agent/hooks/memory.ts").startsWith("OPE-2692"), "tier 1: hooks map to OPE-2692");
  ok(sliceOf("packages/providers/slack/agent/x.ts").startsWith("OPE-2693"), "tier 1: providers map to OPE-2693");
  ok(sliceOf("tests/integration/harness.ts").startsWith("OPE-2695"), "tier 1: the integration tier maps to OPE-2695");
  ok(sliceOf("agent/agent.ts").startsWith("OPE-2694"), "tier 1: the root agent maps to OPE-2694");
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const installed = join(ROOT, "node_modules", "eve");

if (process.argv.includes("--write")) {
  const { version, names } = eveEventNames(installed);
  writeFileSync(join(ROOT, TABLE_FILE), renderTable(version, names));
  console.log(`✓ wrote ${TABLE_FILE}: ${names.length} event names from eve ${version}`);
  process.exit(0);
}

const otherRoot = argValue("--eve-root");
if (otherRoot !== undefined) {
  const { version, names } = eveEventNames(otherRoot);
  const findings = scanTree(new Set(names));
  const files = new Set(findings.map((f) => f.file));
  console.log(`eve ${version} at ${relative(ROOT, otherRoot) || otherRoot}: ${names.length} event names.`);
  if (findings.length === 0) {
    console.log(`✓ every event-name literal in this tree names an event eve ${version} emits.`);
    process.exit(0);
  }
  console.log(`✗ ${findings.length} event-name literal(s) in ${files.size} file(s) name an event eve ${version} does not emit:\n${report(findings)}`);
  process.exit(1);
}

tier1();

const live = eveEventNames(installed);
const table: string[] = [...EVE_EVENT_NAMES].sort();
const removed = table.filter((n) => !live.names.includes(n));
const added = live.names.filter((n) => !table.includes(n));
ok(
  live.version === EVE_EVENT_NAMES_PIN && removed.length === 0 && added.length === 0,
  `tier 2: ${TABLE_FILE} is for eve ${EVE_EVENT_NAMES_PIN}, the installed eve is ${live.version} ` +
    `(removed: ${removed.join(", ") || "none"}; added: ${added.join(", ") || "none"}). ` +
    `Run \`npm run lint:eve-event-names -- --write\`, then fix every consumer the lint names.`,
);

const stale = staleExemptions((file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), "utf8") : undefined));
ok(stale.length === 0, `tier 2: NOT_EVE_EVENTS rows whose file no longer holds the literal — drop them: ${stale.join(", ")}`);

const findings = scanTree(new Set(EVE_EVENT_NAMES));
if (findings.length > 0) {
  console.error(
    `✗ tier 3: ${findings.length} event-name literal(s) name an event eve ${EVE_EVENT_NAMES_PIN} does not emit. ` +
      `A consumer of a missing name compiles and then never fires:\n${report(findings)}`,
  );
  process.exit(1);
}
passed++;

console.log(`✓ lint:eve-event-names: ${passed} checks — every event-name literal names an event eve ${EVE_EVENT_NAMES_PIN} emits (${EVE_EVENT_NAMES.length} names).`);
