import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_FILE = "packages/core/agent/audit/cross-room-send.ts";

interface AuthWriter {
  readonly file: string;
  readonly path: string;
}

export const EVE_AUTH_WRITERS: readonly AuthWriter[] = [
  { file: "execution/runtime-context.js", path: "a new session's context: the delivery's `auth` (or the initiator's), as the channel route minted it" },
  {
    file: "execution/session/turn-step.js",
    path: "each turn step: the delivery's own auth, a sign-in challenge's requester, then a closing write that restores the earlier value — except a mid-turn message of the same principal, whose bag replaces it (continueTurnAuth)",
  },
  {
    file: "execution/proxied-deliver-step.js",
    path: "a proxied answers delivery: its own `delivery.auth` in a scratch context for the channel's `deliver`, and joinAnswerToTurn's continueTurnAuth write to the parent's slot",
  },
  { file: "execution/tools/workflow/step-execution.js", path: "a durable tool step: re-applies the auth the step was queued under" },
  {
    file: "execution/cancelled-model-call-batch.js",
    path: "a cancelled model-call batch: copies the turn step's own slot forward (a copy, never a new principal)",
  },
  {
    file: "channel/schedule.js",
    path: "a schedule-collection occurrence: the principal that created the schedule, from its stored envelope. OE deploys no collection (rule E), and eve refuses an occurrence of an undeployed one before the write",
  },
  {
    file: "execution/invoke-tool.js",
    path: "a tool call outside a conversation: the `auth` option of the `invokeTool` caller, verbatim. No OE module calls `invokeTool` (rule E)",
  },
  {
    file: "runtime/connections/events/dispatch-step.js",
    path: "a connection-event callback: the auth on the stored subscription binding. OE declares no connection events (rule C)",
  },
  {
    file: "runtime/connections/events/owner.js",
    path: "a connection-event owner: the same stored binding auth, a clone of the subscribing session's slot. OE declares no connection events (rule C)",
  },
];

export const AUTH_WRITE =
  /\.(?:set|setVirtualContext|ensure)\(\s*AuthKey\s*,|\.delete\(\s*AuthKey\s*\)|[{,]\s*(?:\[AuthKey\.name\]|\[\s*[`"']eve\.auth[`"']\s*\]|[`"']eve\.auth[`"'])\s*:|[A-Za-z0-9_$)\]](?:\[AuthKey\.name\]|\[\s*[`"']eve\.auth[`"']\s*\])\s*(?:\?\?|\|\||&&)?=(?!=)|\bdelete\s+[A-Za-z0-9_$.)\]]+(?:\[AuthKey\.name\]|\[\s*[`"']eve\.auth[`"']\s*\])/;
const AUTH_KEY_DECLARATION = /\bAuthKey\s*=\s*new ContextKey\(\s*[`"']eve\.auth[`"']\s*\)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.name.endsWith(".js")) out.push(abs);
  }
  return out;
}

export function authWriters(eveRoot: string): { version: string; writers: string[] } {
  const root = resolve(eveRoot);
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const src = join(root, "dist", "src");
  let declared = false;
  const writers: string[] = [];
  for (const abs of walk(src)) {
    const text = readFileSync(abs, "utf8");
    if (AUTH_KEY_DECLARATION.test(text)) declared = true;
    if (AUTH_WRITE.test(text)) writers.push(relative(src, abs).split("\\").join("/"));
  }
  if (!declared) throw new Error(`eve ${version} at ${root}: no \`AuthKey = new ContextKey("eve.auth")\` declaration — the key was renamed, so this census reads nothing. Re-derive it.`);
  return { version, writers: writers.sort() };
}

export function censusDiff(found: readonly string[], table: readonly AuthWriter[]): { added: string[]; gone: string[] } {
  const known = new Set(table.map((w) => w.file));
  return { added: found.filter((f) => !known.has(f)), gone: [...known].filter((f) => !found.includes(f)) };
}

function censusMessage(version: string, diff: { added: string[]; gone: string[] }): string {
  const lines: string[] = [];
  for (const f of diff.added) {
    lines.push(`  NEW WRITER  ${f} — a new eve path writes the session auth. Pin the principal it carries with a spec before the bump lands, then add a row to EVE_AUTH_WRITERS.`);
  }
  for (const f of diff.gone) lines.push(`  GONE        ${f} — eve ${version} no longer writes the session auth here. Find where its path moved, then drop the row.`);
  return lines.join("\n");
}

type ScheduleRow =
  | { readonly sends: false; readonly does: string }
  | { readonly sends: true; readonly does: string; readonly auth: string; readonly pinnedBy: readonly string[] };

export const OE_SCHEDULES: Readonly<Record<string, ScheduleRow>> = {
  "packages/core/agent/schedules/audit-export.ts": { sends: false, does: "exports the audit log to the configured sink" },
  "packages/core/agent/schedules/cover-recap.ts": {
    sends: true,
    does: "sends a covering person their recap in a 1:1 DM",
    auth: "eve's `appAuth`, plus the cover-recap fire stamps (cover/recap.ts)",
    pinnedBy: ["packages/core/scripts/cover-test.ts"],
  },
  "packages/core/agent/schedules/directory-sync.ts": { sends: false, does: "syncs the workspace directory" },
  "packages/core/agent/schedules/dispatch.ts": {
    sends: true,
    does: "fires due routines into their channel",
    auth: "eve's `appAuth`, plus `oe_fire_principal` / `oe_fire_unattended` (schedules/dispatch.ts)",
    pinnedBy: ["tests/integration/routine-fire-attendedness.test.ts", "packages/core/scripts/fire-principal-test.ts"],
  },
  "packages/core/agent/schedules/dream-mode3.ts": { sends: false, does: "runs the weekly memory digest" },
  "packages/core/agent/schedules/meeting-sweep.ts": { sends: false, does: "sweeps meeting state" },
  "packages/core/agent/schedules/personal-browser-sweep.ts": { sends: false, does: "sweeps personal-browser sessions" },
  "packages/core/agent/schedules/personal-watch.ts": {
    sends: true,
    does: "sends a person a watch nudge in a 1:1 DM",
    auth: "eve's `appAuth`, plus the personal-watch fire stamps (routines/fire-auth.ts)",
    pinnedBy: ["packages/core/scripts/personal-watch-test.ts"],
  },
  "packages/core/agent/schedules/tidy.ts": { sends: false, does: "tidies memory silos" },
  "packages/providers/notion/agent/schedules/notion-ingress.ts": { sends: false, does: "polls Notion for ingress" },
};

const SCHEDULE_SOURCES: ReadonlySet<string> = new Set(["eve/schedules", "eve"]);

const SENDS = /\bto\s*\(|\bargs\.to\b|\{\s*to\b|\bto\s*:\s*args\b|\bappAuth\b/;

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly [key: string]: unknown;
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function visitAll(program: AstNode, fn: (node: AstNode, chain: readonly AstNode[]) => void): void {
  const chain: AstNode[] = [];
  const visit = (node: AstNode): void => {
    fn(node, chain);
    chain.unshift(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "type") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item);
      } else if (isNode(value)) visit(value);
    }
    chain.shift();
  };
  visit(program);
}

function blankComments(file: string, text: string): string {
  const comments = (parseSync(file, text) as unknown as { comments: readonly { start: number; end: number }[] }).comments;
  let out = text;
  for (const c of comments) out = out.slice(0, c.start) + " ".repeat(c.end - c.start) + out.slice(c.end);
  return out;
}

function parse(file: string, text: string): AstNode {
  return (parseSync(file, text) as unknown as { program: AstNode }).program;
}

function calleeName(node: AstNode): string | undefined {
  const callee = node.callee as AstNode | undefined;
  if (callee?.type === "Identifier") return callee.name as string;
  return undefined;
}

function definerNames(program: AstNode, exported: string, sources: ReadonlySet<string>): { names: Set<string>; imports: boolean } {
  const names = new Set([exported]);
  let imports = false;
  for (const stmt of (program.body as AstNode[]) ?? []) {
    if (stmt.type !== "ImportDeclaration") continue;
    for (const spec of (stmt.specifiers as AstNode[]) ?? []) {
      const imported = spec.imported as { name?: string; value?: string } | undefined;
      if (spec.type === "ImportSpecifier" && (imported?.name ?? imported?.value) === exported) {
        names.add((spec.local as { name: string }).name);
        imports = true;
      }
      if (spec.type === "ImportNamespaceSpecifier" && stmt.importKind !== "type" && sources.has(String((stmt.source as { value?: unknown }).value))) imports = true;
    }
  }
  return { names, imports };
}

function memberPropName(node: AstNode): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  const property = node.property as AstNode;
  if (node.computed === false) return property.type === "Identifier" ? (property.name as string) : undefined;
  return staticString(property);
}

function callsDefiner(node: AstNode, names: ReadonlySet<string>, exported: string): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AstNode;
  if (callee.type === "Identifier") return names.has(callee.name as string);
  return memberPropName(callee) === exported;
}

function definerReference(node: AstNode, chain: readonly AstNode[], names: ReadonlySet<string>, exported: string): string | undefined {
  const parent = chain[0];
  const isCallee = parent?.type === "CallExpression" && parent.callee === node;
  if (isCallee) return undefined;
  if (node.type === "Identifier" && names.has(node.name as string)) {
    if (parent?.type === "ImportSpecifier") return undefined;
    if (parent?.type === "MemberExpression" && parent.property === node && parent.computed === false) return undefined;
    if (parent?.type === "Property" && parent.key === node && parent.shorthand !== true && chain[1]?.type === "ObjectExpression") return undefined;
    if (parent?.type === "Property" && parent.key === node && chain[1]?.type === "ObjectPattern") return "the definer is destructured, not called";
    return "the definer is referenced, not called";
  }
  if (memberPropName(node) === exported) return "the namespaced definer is referenced, not called";
  if (node.type === "Property" && parent?.type === "ObjectPattern") {
    const key = node.key as AstNode;
    const name = node.computed === true || key.type !== "Identifier" ? staticString(key) : undefined;
    if (name === exported) return "the definer is destructured by a string key, not called";
  }
  return undefined;
}

function unreadDefinition(def: AstNode | undefined): string | undefined {
  if (def === undefined) return "the definition is not an inline object literal";
  for (const p of (def.properties as AstNode[]) ?? []) {
    if (p.type === "SpreadElement") return "the definition spreads another object";
    if (p.type === "Property" && p.computed === true && !((p.key as AstNode).type === "Literal" && typeof (p.key as AstNode).value === "string")) {
      return "the definition has a computed key";
    }
  }
  return undefined;
}

function propertyKey(prop: AstNode): string | undefined {
  const key = prop.key as AstNode | undefined;
  if (key?.type === "Identifier") return key.name as string;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function firstObjectArgument(call: AstNode): AstNode | undefined {
  const arg = (call.arguments as AstNode[] | undefined)?.[0];
  return arg?.type === "ObjectExpression" ? arg : undefined;
}

export function scheduleFindings(file: string, text: string, row: ScheduleRow | undefined, exists: (path: string) => boolean): Finding[] {
  const findings: Finding[] = [];
  let defines = false;
  let runTakesArgs = false;
  const program = parse(file, text);
  const definer = definerNames(program, "defineSchedule", SCHEDULE_SOURCES);
  const unread = (node: AstNode, what: string): void => {
    findings.push({
      file,
      line: lineAt(text, node.start),
      rule: "unrecognised schedule form",
      detail: `${what}. Rule B reads only \`defineSchedule({ … })\` with an inline object literal, so it cannot check this schedule's \`run\` or \`markdown\`. Call it that way.`,
    });
  };
  let exportsDefault = false;
  visitAll(program, (node, chain) => {
    if (node.type === "ExportDefaultDeclaration") exportsDefault = true;
    const reference = definerReference(node, chain, definer.names, "defineSchedule");
    if (reference !== undefined) unread(node, reference);
    if (!callsDefiner(node, definer.names, "defineSchedule")) return;
    defines = true;
    const def = firstObjectArgument(node);
    const why = unreadDefinition(def);
    if (why !== undefined) {
      unread(node, why);
      runTakesArgs = true;
    }
    for (const prop of (def?.properties as AstNode[] | undefined) ?? []) {
      if (prop.type === "Property" && propertyKey(prop) === "run") {
        const value = prop.value as AstNode | undefined;
        const inlineNoArgs = value !== undefined && FUNCTION_TYPES.has(value.type) && ((value.params as unknown[] | undefined)?.length ?? 0) === 0;
        if (!inlineNoArgs) runTakesArgs = true;
      }
      if (prop.type === "Property" && propertyKey(prop) === "markdown") {
        findings.push({
          file,
          line: lineAt(text, prop.start),
          rule: "markdown schedule",
          detail: "a `markdown:` schedule runs the agent under eve's schedule principal with no OE fire stamp. Use the `run` form, and pin the principal it sends with by a spec.",
        });
      }
    }
  });
  if (!defines) {
    if (exportsDefault && /(^|\/)agent\/schedules\//.test(file)) {
      unread(program, "the module default-exports a value that is not a `defineSchedule({ … })` call, and eve runs any default export under agent/schedules/ as a schedule");
      return findings;
    }
    if (definer.imports) {
      findings.push({
        file,
        line: 1,
        rule: "unrecognised schedule form",
        detail: "this module imports eve's `defineSchedule` (or an eve namespace) but calls it in a form this lint does not read. Call `defineSchedule({ … })` directly, so rule B can check it.",
      });
    }
    return findings;
  }
  if (row === undefined) {
    findings.push({
      file,
      line: 1,
      rule: "unlisted schedule",
      detail: "a new eve schedule. A scheduled run carries eve's schedule auth: pin the auth principal of this path with a spec first, then add a row to OE_SCHEDULES (scripts/eve-auth-paths-lint.ts).",
    });
    return findings;
  }
  const sends = runTakesArgs || SENDS.test(blankComments(file, text));
  if (!row.sends && sends) {
    findings.push({
      file,
      line: 1,
      rule: "code-only schedule sends",
      detail: "this schedule's row says code-only, but its `run` now takes eve's handler args or the module names `to(` / `appAuth`. Pin the auth it sends with by a spec first, then mark the row as sending.",
    });
  }
  if (row.sends) {
    for (const spec of row.pinnedBy) {
      if (!exists(spec)) findings.push({ file, line: 1, rule: "missing pin", detail: `the row names ${spec} as the spec that pins this schedule's auth, and that file does not exist.` });
    }
  }
  return findings;
}

const CONNECTION_DEFINERS = new Set(["defineMcpClientConnection", "defineOpenAPIConnection"]);
const CONNECTION_SOURCES: ReadonlySet<string> = new Set(["eve/connections", "eve"]);

export function connectionEventFindings(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const program = parse(file, text);
  const aliases = new Map<string, string>();
  for (const exported of CONNECTION_DEFINERS) for (const local of definerNames(program, exported, CONNECTION_SOURCES).names) aliases.set(local, exported);
  const unread = (node: AstNode, name: string, why: string): void => {
    findings.push({
      file,
      line: lineAt(text, node.start),
      rule: "unrecognised connection form",
      detail: `${why} (\`${name}\`), so rule C cannot see whether it declares \`events\`. Call it directly with an inline object literal.`,
    });
  };
  const names = new Set(aliases.keys());
  visitAll(program, (node, chain) => {
    for (const exported of CONNECTION_DEFINERS) {
      const own = new Set([...aliases].filter(([, e]) => e === exported).map(([local]) => local));
      const reference = definerReference(node, chain, own, exported);
      if (reference !== undefined) unread(node, exported, reference);
    }
    if (node.type !== "CallExpression") return;
    const callee = node.callee as AstNode;
    const member = memberPropName(callee);
    const name = callee.type === "Identifier" ? (names.has(callee.name as string) ? aliases.get(callee.name as string) : undefined) : member !== undefined && CONNECTION_DEFINERS.has(member) ? member : undefined;
    if (name === undefined) return;
    const def = firstObjectArgument(node);
    const why = unreadDefinition(def);
    if (why !== undefined || def === undefined) {
      unread(node, name, why ?? "the definition is not an inline object literal");
      return;
    }
    const refuseEvents = (prop: AstNode, shape: string): void => {
      findings.push({
        file,
        line: lineAt(text, prop.start),
        rule: "connection events",
        detail: `\`${name}({ ${shape} })\` subscribes to connection events, which run under an auth eve writes itself (rc.18: runtime/connections/events/owner.js). Pin the auth principal of that path with a spec first.`,
      });
    };
    for (const prop of (def.properties as AstNode[] | undefined) ?? []) {
      if (prop.type === "Property" && propertyKey(prop) === "events") refuseEvents(prop, "events");
      if (prop.type === "Property" && propertyKey(prop) === "experimental") {
        const block = prop.value as AstNode | undefined;
        const blockWhy = block?.type === "ObjectExpression" ? unreadDefinition(block) : "the `experimental` block is not an inline object literal";
        if (blockWhy !== undefined) {
          unread(prop, name, blockWhy.replace("the definition", "the `experimental` block"));
          continue;
        }
        for (const inner of (block!.properties as AstNode[] | undefined) ?? []) {
          if (inner.type === "Property" && propertyKey(inner) === "events") refuseEvents(inner, "experimental: { events }");
        }
      }
    }
  });
  return findings;
}

const OPT_IN_NAMES: Readonly<Record<string, string>> = {
  invokeTool: "eve's `invokeTool` runs a tool outside a conversation under the `auth` its caller passes (rc.18: execution/invoke-tool.js), so a route could hand it a principal read from the request",
  mcpChannel: "eve's `mcpChannel` publishes the agent's tools, and each call runs under the MCP caller's auth through `invokeTool` (rc.18: execution/invoke-tool.js)",
  defineDynamicSchedules: "a schedule collection runs each occurrence under the principal that created the schedule, not under the room it posts to (rc.18: channel/schedule.js)",
};
const OPT_IN_SOURCES: Readonly<Record<string, string>> = {
  "eve/channels/mcp": OPT_IN_NAMES.mcpChannel!,
  "eve/experimental/schedules": OPT_IN_NAMES.defineDynamicSchedules!,
};


function staticString(node: AstNode): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && ((node.expressions as unknown[] | undefined)?.length ?? 0) === 0) {
    const quasi = (node.quasis as { value?: { cooked?: string | null } }[] | undefined)?.[0];
    return quasi?.value?.cooked ?? undefined;
  }
  return undefined;
}

export function optInWriterFindings(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const refuse = (node: AstNode, what: string, why: string): void => {
    findings.push({
      file,
      line: lineAt(text, node.start),
      rule: "opt-in auth writer",
      detail: `${what}: ${why}. OE holds its identity guarantees only while no module reaches this path. Pin the principal it carries with a spec first, then change this rule.`,
    });
  };
  const sourceOf = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    return Object.keys(OPT_IN_SOURCES).find((s) => value === s || value.startsWith(`${s}/`));
  };
  visitAll(parse(file, text), (node) => {
    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ImportExpression") {
      const sourceNode = node.source as AstNode | null | undefined;
      const source = sourceNode === null || sourceNode === undefined ? undefined : staticString(sourceNode);
      const hit = sourceOf(source);
      if (hit !== undefined) refuse(node, `an import of \`${String(source)}\``, OPT_IN_SOURCES[hit]!);
    }
    if (node.type === "Identifier" && Object.hasOwn(OPT_IN_NAMES, node.name as string)) refuse(node, `\`${node.name as string}\``, OPT_IN_NAMES[node.name as string]!);
    const literal = staticString(node);
    if (literal !== undefined && Object.hasOwn(OPT_IN_NAMES, literal)) refuse(node, `the string "${literal}"`, OPT_IN_NAMES[literal]!);
    if (node.type === "CallExpression") {
      const first = (node.arguments as AstNode[] | undefined)?.[0];
      const spec = first === undefined ? undefined : staticString(first);
      const hit = sourceOf(spec);
      if (hit !== undefined) refuse(node, `a load of \`${spec!}\``, OPT_IN_SOURCES[hit]!);
    }
  });
  return findings;
}

const CONTEXT_NAME = /^(ctx\w*|context\w*|[a-z]\w*(Ctx|Context))$/;

export function crossRoomFindings(file: string, text: string): Finding[] {
  if (file === WRAPPER_FILE) return [];
  const findings: Finding[] = [];
  const refuse = (node: AstNode, what: string): void => {
    findings.push({
      file,
      line: lineAt(text, node.start),
      rule: "bare ctx.to",
      detail: `${what} reaches a session on another channel with no audit row. Call \`auditedCrossRoomSend\` (${WRAPPER_FILE}) instead.`,
    });
  };
  const inToolCode = (chain: readonly AstNode[]): boolean => {
    const holder = chain[0];
    if ((holder?.type === "Property" || holder?.type === "MethodDefinition") && propertyKey(holder) === "execute") return true;
    return chain.some((n) => n.type === "CallExpression" && calleeName(n) === "defineTool");
  };
  visitAll(parse(file, text), (node, chain) => {
    if (node.type === "MemberExpression") {
      const property = node.property as AstNode;
      const named = node.computed === false ? property.type === "Identifier" && property.name === "to" : property.type === "Literal" && property.value === "to";
      const object = node.object as AstNode;
      if (named && object.type === "Identifier" && CONTEXT_NAME.test(object.name as string)) refuse(node, `\`${object.name as string}.to\``);
    }
    if (node.type === "VariableDeclarator" && (node.id as AstNode).type === "ObjectPattern") {
      const init = node.init as AstNode | null;
      if (init?.type === "Identifier" && CONTEXT_NAME.test(init.name as string)) {
        for (const prop of ((node.id as AstNode).properties as AstNode[]) ?? []) {
          if (prop.type === "Property" && propertyKey(prop) === "to") refuse(prop, `\`const { to } = ${init.name as string}\``);
        }
      }
    }
    if (FUNCTION_TYPES.has(node.type) && inToolCode(chain)) {
      for (const param of (node.params as AstNode[] | undefined) ?? []) {
        const pattern = param.type === "AssignmentPattern" ? (param.left as AstNode) : param;
        if (pattern.type !== "ObjectPattern") continue;
        for (const prop of (pattern.properties as AstNode[]) ?? []) {
          if (prop.type === "Property" && propertyKey(prop) === "to") refuse(prop, "a `{ to }` parameter");
        }
      }
    }
  });
  return findings;
}

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
}

function isAgentSource(file: string): boolean {
  return /\.(ts|tsx|mts|js|mjs)$/.test(file) && !file.endsWith(".d.ts") && /(^|\/)agent\//.test(file) && !file.includes("/docs/generated/");
}

function treeFindings(): Finding[] {
  const findings: Finding[] = [];
  const exists = (p: string): boolean => existsSync(join(ROOT, p));
  const files = tracked();
  const seenSchedules = new Set<string>();
  for (const file of files) {
    if (!isAgentSource(file)) {
      if (/(^|\/)agent\/schedules\/.+\.md$/.test(file)) {
        findings.push({ file, line: 1, rule: "markdown schedule", detail: "a `<name>.md` schedule runs the agent under eve's schedule principal with no OE fire stamp. Use a `run` schedule, and pin the principal it sends with by a spec." });
      }
      continue;
    }
    const text = readFileSync(join(ROOT, file), "utf8");
    if (/(^|\/)agent\/schedules\/.+/.test(file)) {
      if (text.includes("defineSchedule")) seenSchedules.add(file);
      findings.push(...scheduleFindings(file, text, OE_SCHEDULES[file], exists));
    }
    findings.push(...connectionEventFindings(file, text));
    if (/\.to\b|\[\s*["'`]to["'`]\s*\]|[{,]\s*to\b/.test(text)) findings.push(...crossRoomFindings(file, text));
    findings.push(...optInWriterFindings(file, text));
  }
  for (const file of Object.keys(OE_SCHEDULES)) {
    if (!seenSchedules.has(file)) findings.push({ file, line: 1, rule: "stale row", detail: "OE_SCHEDULES names a schedule module that no longer calls `defineSchedule`. Drop the row." });
  }
  return findings;
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
  const table = EVE_AUTH_WRITERS.map((w) => w.file);
  const rcLike = [...table, "channel/future-writer.js", "runtime/future/owner.js", "execution/future-invoke.js"];
  const diff = censusDiff(rcLike, EVE_AUTH_WRITERS);
  ok(diff.added.length === 3 && censusMessage("x", diff).includes("NEW WRITER  channel/future-writer.js"), "tier 1 A: a bump that adds auth writers is refused, naming each new writer");
  ok(censusDiff(table.slice(1), EVE_AUTH_WRITERS).gone.length === 1, "tier 1 A: a writer that disappears is refused");
  ok(censusDiff(table, EVE_AUTH_WRITERS).added.length === 0 && censusDiff(table, EVE_AUTH_WRITERS).gone.length === 0, "tier 1 A control: the table's own writers pass");
  ok(AUTH_WRITE.test("r.set(AuthKey,i)"), "tier 1 A: a `.set(AuthKey,` context write is a writer");
  ok(AUTH_WRITE.test("t.setVirtualContext(AuthKey,i.auth)"), "tier 1 A: a `.setVirtualContext(AuthKey,` write is a writer");
  ok(AUTH_WRITE.test("r={...e.ctx,[AuthKey.name]:t[AuthKey.name]}"), "tier 1 A: a computed `[AuthKey.name]:` key in a serialized context is a writer");
  ok(AUTH_WRITE.test("n[AuthKey.name]=continueTurnAuth(e,t)"), "tier 1 A: a member write `n[AuthKey.name]=` is a writer");
  ok(AUTH_WRITE.test("M===void 0?s.delete(AuthKey):s.set(AuthKey,M)") && AUTH_WRITE.test("s.delete(AuthKey)"), "tier 1 A: a `.delete(AuthKey)` is a writer");
  ok(AUTH_WRITE.test("c.ensure(AuthKey,()=>a)"), "tier 1 A: an `.ensure(AuthKey,` is a writer");
  ok(AUTH_WRITE.test("r={...e,[`eve.auth`]:a}") && AUTH_WRITE.test('r={x:1,"eve.auth":a}'), "tier 1 A: a literal `eve.auth` key in a serialized context is a writer");
  ok(AUTH_WRITE.test("n[`eve.auth`]=a"), "tier 1 A: a literal `eve.auth` member write is a writer");
  ok(AUTH_WRITE.test("n[AuthKey.name]??=a") && AUTH_WRITE.test("n[AuthKey.name]||=a") && AUTH_WRITE.test("n[`eve.auth`]&&=a"), "tier 1 A: a logical-assignment member write is a writer");
  ok(AUTH_WRITE.test("delete n[AuthKey.name]") && AUTH_WRITE.test("delete e.ctx[`eve.auth`]"), "tier 1 A: the `delete` operator on the auth member is a writer");
  ok(!AUTH_WRITE.test("principalOf(t[`eve.auth`])") && !AUTH_WRITE.test("t[`eve.auth`]===a"), "tier 1 A control: a literal `eve.auth` read is not a writer");
  ok(!AUTH_WRITE.test("r.get(AuthKey)") && !AUTH_WRITE.test("r.set(InitiatorAuthKey,i)") && !AUTH_WRITE.test("r.delete(InitiatorAuthKey)"), "tier 1 A control: a read, and a write of another key, are not writers");
  ok(!AUTH_WRITE.test("principalOf(n===void 0?t[AuthKey.name]:n)") && !AUTH_WRITE.test("if(e[AuthKey.name]===x)"), "tier 1 A control: a `?:` read and an `===` read of AuthKey.name are not writers");

  const always = (): boolean => true;
  const codeOnly = `import { defineSchedule } from "eve/schedules";\nexport default defineSchedule({ cron: "0 * * * *", async run() { await sweep(); } });\n`;
  const sending = `import { defineSchedule } from "eve/schedules";\nexport default defineSchedule({ cron: "0 9 * * 1-5", async run({ to, appAuth }) { await to(slack, { channelId: "C1" }).send("hi", { auth: appAuth }); } });\n`;
  const markdown = `import { defineSchedule } from "eve/schedules";\nexport default defineSchedule({ cron: "0 9 * * *", markdown: "Post the standup." });\n`;
  const unlisted = scheduleFindings("packages/core/agent/schedules/new.ts", sending, undefined, always);
  ok(unlisted.length === 1 && unlisted[0]!.rule === "unlisted schedule" && unlisted[0]!.detail.includes("pin the auth principal of this path with a spec first"), "tier 1 B: a new schedule file is refused, and the message says to pin its principal by a spec first");
  ok(scheduleFindings("s.ts", markdown, { sends: false, does: "x" }, always).some((f) => f.rule === "markdown schedule"), "tier 1 B: a markdown schedule is refused");
  ok(scheduleFindings("s.ts", sending, { sends: false, does: "x" }, always).some((f) => f.rule === "code-only schedule sends"), "tier 1 B: a code-only row whose module starts to send is refused");
  ok(scheduleFindings("s.ts", sending, { sends: true, does: "x", auth: "y", pinnedBy: ["gone.ts"] }, () => false).some((f) => f.rule === "missing pin"), "tier 1 B: a sending row whose pinning spec is gone is refused");
  ok(scheduleFindings("s.ts", codeOnly, { sends: false, does: "x" }, always).length === 0, "tier 1 B control: a listed code-only schedule passes");
  const argsOnly = `import { defineSchedule } from "eve/schedules";\nexport default defineSchedule({ cron: "0 * * * *", async run(args) { await sweep(args); } });\n`;
  ok(scheduleFindings("s.ts", argsOnly, { sends: false, does: "x" }, always).some((f) => f.rule === "code-only schedule sends"), "tier 1 B: a code-only row whose `run` starts to take eve's args is refused, whatever it calls them");
  const commented = `import { defineSchedule } from "eve/schedules";\n// it used to send it to (the room) with appAuth\nexport default defineSchedule({ cron: "0 * * * *", async run() { await sweep(); } });\n`;
  const aliased = `import { defineSchedule as ds } from "eve/schedules";\nexport default ds({ cron: "0 9 * * *", markdown: "Post the standup." });\n`;
  ok(scheduleFindings("s.ts", aliased, { sends: false, does: "x" }, always).some((f) => f.rule === "markdown schedule"), "tier 1 B: an aliased `defineSchedule` is read (its markdown form is refused)");
  const namespaced = `import * as schedules from "eve/schedules";\nexport default schedules.defineSchedule({ cron: "0 9 * * *", markdown: "x" });\n`;
  ok(scheduleFindings("s.ts", namespaced, { sends: false, does: "x" }, always).some((f) => f.rule === "markdown schedule"), "tier 1 B: a namespaced `schedules.defineSchedule` is read");
  const wrapped = `import { defineSchedule } from "eve/schedules";\nconst make = defineSchedule;\nexport default make({ cron: "0 9 * * *", markdown: "x" });\n`;
  ok(scheduleFindings("s.ts", wrapped, undefined, always).some((f) => f.rule === "unrecognised schedule form"), "tier 1 B: a module that imports defineSchedule and calls it in an unread form is refused");
  const handlerRef = `import { defineSchedule } from "eve/schedules";\nimport { handler } from "./shared.js";\nexport default defineSchedule({ cron: "0 * * * *", run: handler });\n`;
  ok(scheduleFindings("s.ts", handlerRef, { sends: false, does: "x" }, always).some((f) => f.rule === "code-only schedule sends"), "tier 1 B: a code-only row whose `run` is not an inline function fails closed");
  const viaVar = `import { defineSchedule } from "eve/schedules";\nconst config = { cron: "0 * * * *", markdown: "x" };\nexport default defineSchedule(config);\n`;
  ok(scheduleFindings("s.ts", viaVar, { sends: false, does: "x" }, always).some((f) => f.rule === "unrecognised schedule form"), "tier 1 B: a definition passed as a variable is refused");
  const viaSpread = `import { defineSchedule } from "eve/schedules";\nexport default defineSchedule({ ...base });\n`;
  ok(scheduleFindings("s.ts", viaSpread, { sends: false, does: "x" }, always).some((f) => f.rule === "unrecognised schedule form"), "tier 1 B: a spread definition is refused");
  const mixed = `import { defineSchedule } from "eve/schedules";\nexport const a = defineSchedule({ cron: "0 * * * *", async run() {} });\nconst make = defineSchedule;\nexport default make({ cron: "0 9 * * *", markdown: "x" });\n`;
  ok(scheduleFindings("s.ts", mixed, { sends: false, does: "x" }, always).some((f) => f.rule === "unrecognised schedule form"), "tier 1 B: an unread definer reference is refused even beside a recognised call");
  const typeNs = `// routine-dispatch: this helper is not a defineSchedule module\nimport type * as channels from "eve/channels";\nimport * as eveRoot from "eve/hooks";\nexport function helper(c: channels.X) { return c; }\n`;
  ok(scheduleFindings("s.ts", typeNs, undefined, always).length === 0, "tier 1 B control: a helper with a type namespace import and an unrelated eve namespace passes");
  const plainObject = `export default { cron: "0 9 * * *", markdown: "Post the standup." };\n`;
  ok(scheduleFindings("packages/core/agent/schedules/team/standup.ts", plainObject, undefined, always).some((f) => f.rule === "unrecognised schedule form"), "tier 1 B: a nested schedule module that default-exports a plain object is refused");
  const helperNoDefault = `export function routineHelper() { return 1; }\n`;
  ok(scheduleFindings("packages/core/agent/schedules/routine-helper.ts", helperNoDefault, undefined, always).length === 0, "tier 1 B control: a schedules-directory helper with no default export passes");
  const destructured = `const { defineSchedule: ds } = await import("eve/schedules");\nexport default ds({ cron: "0 9 * * *", markdown: "x" });\n`;
  ok(scheduleFindings("s.ts", destructured, undefined, always).some((f) => f.rule === "unrecognised schedule form"), "tier 1 B: a definer destructured off a dynamic import is refused");
  const computedMember = `import eve from "eve";\nexport default eve["defineSchedule"]({ cron: "0 9 * * *", markdown: "x" });\n`;
  ok(scheduleFindings("s.ts", computedMember, { sends: false, does: "x" }, always).some((f) => f.rule === "markdown schedule"), "tier 1 B: a computed-member definer call is read");
  const computedKey = `import { defineSchedule } from "eve/schedules";\nconst k = "markdown";\nexport default defineSchedule({ cron: "0 9 * * *", [k]: "x" });\n`;
  ok(scheduleFindings("s.ts", computedKey, { sends: false, does: "x" }, always).some((f) => f.rule === "unrecognised schedule form"), "tier 1 B: a definition with a computed key is refused");
  ok(scheduleFindings("s.ts", `const table = { defineSchedule: "a doc word" };\n`, undefined, always).length === 0, "tier 1 B control: an object key that only spells the name passes");
  ok(scheduleFindings("s.ts", commented, { sends: false, does: "x" }, always).length === 0, "tier 1 B control: a comment that says `to (` and `appAuth` is not a send");
  ok(scheduleFindings("s.ts", sending, { sends: true, does: "x", auth: "y", pinnedBy: ["a.ts"] }, always).length === 0, "tier 1 B control: a listed sending schedule with its pin passes");
  ok(scheduleFindings("s.ts", `export function helper() { return to; }\n`, undefined, always).length === 0, "tier 1 B control: a helper module that defines no schedule passes");

  const mcpEvents = `export default defineMcpClientConnection({ url: "https://x", events: { "issue.created": async () => {} } });`;
  ok(connectionEventFindings("c.ts", mcpEvents).length === 1, "tier 1 C: an MCP connection with an events block is refused");
  ok(connectionEventFindings("c.ts", `export default defineOpenAPIConnection({ spec: s, events: {} });`).length === 1, "tier 1 C: an OpenAPI connection with an events block is refused");
  ok(connectionEventFindings("c.ts", `import { defineMcpClientConnection as mcp } from "eve/connections";\nexport default mcp({ url: "https://x", events: {} });`).length === 1, "tier 1 C: an aliased connection definer with an events block is refused");
  ok(connectionEventFindings("c.ts", `import * as c from "eve/connections";\nexport default c.defineOpenAPIConnection({ spec: s, events: {} });`).length === 1, "tier 1 C: a namespaced connection definer with an events block is refused");
  ok(connectionEventFindings("c.ts", `const cfg = { url: "https://x", events: {} };\nexport default defineMcpClientConnection(cfg);`).some((f) => f.rule === "unrecognised connection form"), "tier 1 C: a connection definition passed as a variable is refused");
  ok(connectionEventFindings("c.ts", `export default defineOpenAPIConnection({ ...base });`).some((f) => f.rule === "unrecognised connection form"), "tier 1 C: a spread connection definition is refused");
  ok(connectionEventFindings("c.ts", `import { defineMcpClientConnection } from "eve/connections";\nconst make = defineMcpClientConnection;\nexport default make({ url: "x", events: {} });`).some((f) => f.rule === "unrecognised connection form"), "tier 1 C: an aliased-by-assignment connection definer is refused");
  ok(connectionEventFindings("c.ts", `import * as c from "eve/connections";\nconst d = c.defineMcpClientConnection;\nd({ events: {} });`).some((f) => f.rule === "unrecognised connection form"), "tier 1 C: a namespaced connection definer taken as a value is refused");
  ok(connectionEventFindings("c.ts", `import * as c from "eve/connections";\nexport default c["defineMcpClientConnection"]({ url: "x", events: {} });`).some((f) => f.rule === "connection events"), "tier 1 C: a computed-member connection definer call is read");
  ok(
    connectionEventFindings("c.ts", `export default defineMcpClientConnection({ url: "https://x", experimental: { events: { onEvent: async () => {} } } });`).some((f) => f.rule === "connection events"),
    "tier 1 C: the rc.18 shape `experimental: { events }` is refused (eve reads connection events there, not at the top level)",
  );
  ok(
    connectionEventFindings("c.ts", `const x = { events: {} };\nexport default defineMcpClientConnection({ url: "https://x", experimental: x });`).some((f) => f.rule === "unrecognised connection form"),
    "tier 1 C: an `experimental` block passed as a variable is refused",
  );
  ok(
    connectionEventFindings("c.ts", `export default defineMcpClientConnection({ url: "https://x", experimental: { ...more } });`).some((f) => f.rule === "unrecognised connection form"),
    "tier 1 C: a spread `experimental` block is refused",
  );
  ok(
    connectionEventFindings("c.ts", `export default defineMcpClientConnection({ url: "https://x", experimental: { other: true } });`).length === 0,
    "tier 1 C control: an `experimental` block with no `events` passes",
  );
  {
    const viaImport = `import { exp } from "./exp.js";\nexport default defineMcpClientConnection({ url: "https://x", experimental: exp });`;
    ok(connectionEventFindings("c.ts", viaImport).some((f) => f.rule === "unrecognised connection form"), "tier 1 C: an `experimental` block imported from another module is refused");
    const escapedDefiner = String.raw`import * as c from "eve/connections";` + "\n" + String.raw`export default c["defineMcp\ClientConnection"]({ url: "https://x", experimental: { events: {} } });`;
    const ns = `import * as c from "eve/connections";\n`;
    const templateMember = ns + "export default c[`defineMcpClientConnection`]({ url: \"x\", experimental: { events: { onEvent: async () => {} } } });";
    ok(connectionEventFindings("c.ts", templateMember).some((f) => f.rule === "connection events"), "tier 1 C: a definer named by a template-string member is read");
    const templateAlias = ns + "const d = c[`defineMcpClientConnection`];\nexport default d({ url: \"x\", experimental: { events: {} } });";
    ok(connectionEventFindings("c.ts", templateAlias).some((f) => f.rule === "unrecognised connection form"), "tier 1 C: a definer taken by a template-string member is refused");
    const stringKey = ns + `const { "defineMcpClientConnection": d } = c;\nexport default d({ url: "x", experimental: { events: {} } });`;
    ok(connectionEventFindings("c.ts", stringKey).some((f) => f.rule === "unrecognised connection form"), "tier 1 C: a definer destructured by a string key is refused");
    const computedKey = ns + `const { ["defineMcpClientConnection"]: d } = c;\nexport default d({ url: "x", experimental: { events: {} } });`;
    ok(connectionEventFindings("c.ts", computedKey).some((f) => f.rule === "unrecognised connection form"), "tier 1 C: a definer destructured by a computed string key is refused");
    ok(connectionEventFindings("c.ts", `const { ["other"]: o, "x": y } = z;\n`).length === 0, "tier 1 C control: a string-keyed destructure of another name passes");
    ok(connectionEventFindings("c.ts", escapedDefiner).some((f) => f.rule === "connection events"), "tier 1 C: a definer named through an escaped computed key is read (the parser decodes the escape)");
  }
  ok(connectionEventFindings("c.ts", `export default defineDynamic({ events: { "session.started": () => null } });`).length === 0, "tier 1 C control: a dynamic connection's resolver events pass");
  ok(connectionEventFindings("c.ts", `export default defineMcpClientConnection({ url: "https://x" }); // events: none`).length === 0, "tier 1 C control: a connection with no events block passes");

  const route = `routes: [POST("/x", async (req, { invokeTool }) => invokeTool("t", await req.json(), { auth: (await req.json()).auth }))]`;
  ok(optInWriterFindings("packages/core/agent/channels/x.ts", route).some((f) => f.rule === "opt-in auth writer"), "tier 1 E: a route that destructures `invokeTool` is refused");
  ok(optInWriterFindings("x.ts", `async function h(req, args) { return args.invokeTool("t", {}, { auth }); }`).length === 1, "tier 1 E: a member call `args.invokeTool(` is refused");
  ok(optInWriterFindings("x.ts", `async function h(req, args) { return args["invokeTool"]("t", {}, { auth }); }`).length === 1, "tier 1 E: a computed `args[\"invokeTool\"]` is refused");
  ok(optInWriterFindings("x.ts", `import { mcpChannel } from "eve/channels/mcp";\nexport default mcpChannel({});`).length >= 2, "tier 1 E: eve's MCP channel is refused (the import and the name)");
  ok(optInWriterFindings("x.ts", `const m = await import("eve/channels/mcp");`).length === 1, "tier 1 E: a dynamic import of eve's MCP channel is refused");
  ok(
    optInWriterFindings("packages/core/agent/schedules/c.ts", `import { defineDynamicSchedules } from "eve/experimental/schedules";\nexport default defineDynamicSchedules({});`).length >= 2,
    "tier 1 E: a schedule collection is refused (the import and the definer)",
  );
  ok(optInWriterFindings("x.ts", `import { schedules } from "eve/experimental/schedules/vercel";`).length === 1, "tier 1 E: a subpath of eve's experimental schedules is refused");
  ok(optInWriterFindings("x.ts", "async function h(req, args) { return args[`invokeTool`](\"t\", {}, { auth }); }").length === 1, "tier 1 E: a no-substitution template key `args[`invokeTool`]` is refused");
  ok(optInWriterFindings("x.ts", `const require = createRequire(import.meta.url);\nconst m = require("eve/channels/mcp");`).length === 1, "tier 1 E: a `require(\"eve/channels/mcp\")` is refused");
  ok(optInWriterFindings("x.ts", "const m = load(`eve/experimental/schedules`);").length === 1, "tier 1 E: any call that names an opt-in source by a static string is refused");
  ok(optInWriterFindings("x.ts", "const k = `invoke${\"Tool\"}`; const m = require(\"eve/schedules\");").length === 0, "tier 1 E control: a template with a substitution and the static `eve/schedules` source pass (the doc names the run-time escape)");
  {
    const escapedKey = String.raw`async function h(req, args) { return args["\u0069nvokeTool"]("t", {}, { auth }); }`;
    const escapedName = String.raw`async function h(req, args) { return args.\u0069nvokeTool("t", {}, { auth }); }`;
    const escapedSource = String.raw`const m = await import("eve/channels/\x6dcp");`;
    const identityEscape = String.raw`async function h(req, args) { return args["invoke\Tool"]("t", {}, { auth }); }`;
    const continuation = 'async function h(req, args) { return args["invoke\\\nTool"]("t", {}, { auth }); }';
    const templateImport = "const m = await import(`eve/channels/mcp`);";
    const templateSubpath = "const m = await import(`eve/experimental/schedules/vercel`);";
    const escapedTemplate = String.raw`const n = ` + "`mcp\\Channel`;";
    for (const [src, what] of [
      [escapedKey, "an escaped string key"],
      [escapedName, "an escaped identifier"],
      [escapedSource, "an escaped import source"],
      [identityEscape, "an identity escape in a string key"],
      [continuation, "a line continuation in a string key"],
      [templateImport, "a template-string dynamic import"],
      [templateSubpath, "a template-string dynamic import of a subpath"],
      [escapedTemplate, "an identity escape in a template string"],
    ] as const) {
      ok(optInWriterFindings("x.ts", src).length >= 1, `tier 1 E: ${what} is refused`);
    }
  }
  ok(
    optInWriterFindings("x.ts", `// eve's invokeTool is not used here\nimport { defineSchedule } from "eve/schedules";\nexport const invoked = invokeToolkit; const t = "invoke tool";`).length === 0,
    "tier 1 E control: a comment, the static `eve/schedules` path, a longer name and a near-miss string pass",
  );

  const bareTool = `export default defineTool({ async execute(input, ctx) { await ctx.to(slack, { channelId: "C2" }).send("hi"); } });`;
  const bare = crossRoomFindings("packages/core/agent/tools/fixture.ts", bareTool);
  ok(bare.length === 1 && bare[0]!.rule === "bare ctx.to", "tier 1 D: a bare ctx.to( call in a tool is refused");
  ok(crossRoomFindings("t.ts", `async function f(context) { const { to } = context; }`).length === 1, "tier 1 D: destructuring `to` off a context is refused");
  ok(crossRoomFindings("t.ts", `async function f(toolCtx) { toolCtx.to(a, b); }`).length === 1, "tier 1 D: a renamed context is refused");
  ok(crossRoomFindings("t.ts", `async function f(ctx2) { await ctx2.to(a, b).send(m); }`).length === 1, "tier 1 D: a `ctx2` context is refused");
  ok(crossRoomFindings("t.ts", `export default defineTool({ async execute(input, { to }) { await to(slack, t).send(m); } });`).length === 1, "tier 1 D: a `{ to }` parameter in a tool is refused");
  ok(crossRoomFindings("t.ts", `export const t = { execute: async (input, { to } = {}) => to(a, b) };`).length === 1, "tier 1 D: a defaulted `{ to }` parameter on an `execute` is refused");
  ok(crossRoomFindings("t.ts", `async function f(ctx) { const send = ctx.to; await send(a, b).send(m); }`).length === 1, "tier 1 D: an alias of ctx.to is refused");
  ok(crossRoomFindings("t.ts", `async function f(ctx) { await ctx["to"](a, b).send(m); }`).length === 1, "tier 1 D: a computed ctx[\"to\"] is refused");
  ok(crossRoomFindings("packages/core/agent/schedules/x.ts", `defineSchedule({ cron: "* * * * *", async run({ to, appAuth }) { await to(a, b).send(m, { auth: appAuth }); } });`).length === 0, "tier 1 D control: a schedule handler's `{ to }` parameter passes (rule B owns schedules)");
  ok(crossRoomFindings("packages/core/agent/channels/x.ts", `routes: [POST("/x", async (req, { to }) => handle(req, to))]`).length === 0, "tier 1 D control: a channel route handler's `{ to }` passes (the channel plane's ingress)");
  ok(crossRoomFindings("t.ts", `const target = { to: "C1" }; const msg = route.to; f({ from, to });`).length === 0, "tier 1 D control: a `to` field on a non-context object passes");
  ok(crossRoomFindings(WRAPPER_FILE, bareTool).length === 0, "tier 1 D control: the wrapper's own call passes");
  ok(crossRoomFindings("t.ts", `await to(slack, target).send(m, { auth }); await args.to(slack, t).send(m); await auditedCrossRoomSend(ctx, slack, t, m);`).length === 0, "tier 1 D control: a schedule handler's `to(` and the wrapper call pass");
}

function render(findings: readonly Finding[]): string {
  return findings.map((f) => `  ${f.file}:${f.line}  [${f.rule}] ${f.detail}`).join("\n");
}

const otherRootIndex = process.argv.indexOf("--eve-root");
if (otherRootIndex >= 0) {
  const { version, writers } = authWriters(process.argv[otherRootIndex + 1]!);
  const diff = censusDiff(writers, EVE_AUTH_WRITERS);
  if (diff.added.length === 0 && diff.gone.length === 0) {
    console.log(`✓ eve ${version}: the ${writers.length} AuthKey writers match EVE_AUTH_WRITERS.`);
    process.exit(0);
  }
  console.log(`✗ eve ${version}: ${writers.length} AuthKey writers, ${EVE_AUTH_WRITERS.length} in the table:\n${censusMessage(version, diff)}`);
  process.exit(1);
}

tier1();

const installed = authWriters(join(ROOT, "node_modules", "eve"));
const diff = censusDiff(installed.writers, EVE_AUTH_WRITERS);
ok(diff.added.length === 0 && diff.gone.length === 0, `tier 2: the AuthKey writers of eve ${installed.version} differ from EVE_AUTH_WRITERS:\n${censusMessage(installed.version, diff)}`);

const findings = treeFindings();
if (findings.length > 0) {
  console.error(`✗ tier 3: ${findings.length} finding(s):\n${render(findings)}`);
  process.exit(1);
}
passed++;

const sending = Object.values(OE_SCHEDULES).filter((r) => r.sends).length;
console.log(
  `✓ lint:eve-auth-paths: ${passed} checks — eve ${installed.version} has the ${installed.writers.length} known AuthKey writers; ` +
    `${Object.keys(OE_SCHEDULES).length} OE schedules (${sending} send, each pinned); no connection events block; no opt-in auth writer (invokeTool, mcpChannel, a schedule collection); no bare ctx.to.`,
);
