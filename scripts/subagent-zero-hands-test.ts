import { existsSync, readdirSync, readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { disableTool, isDisabledToolSentinel } from "eve/tools";
import { readEveFrameworkTools } from "../packages/core/scripts/eve-framework-tools.js";

const SUBAGENT_ROOT = "agent/subagents/fresh_eyes_review";
const SUBAGENT_DIR = `${SUBAGENT_ROOT}/tools`;
const EVE_ROOT = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
const TOOL_POLICY = join(EVE_ROOT, "dist", "src", "compiler", "default-tool-policy.js");

let checks = 0;
function ok(condition: boolean, what: string): void {
  assert.ok(condition, what);
  checks += 1;
}

const eveTools = await readEveFrameworkTools();
const reserved = eveTools.reserved.map((name) => `tools/${name}`).sort();
ok(existsSync(TOOL_POLICY), `${TOOL_POLICY} exists — eve's tool policy is where the reserved slots are declared, and a moved file makes every clause below vacuous`);
const policySrc = readFileSync(TOOL_POLICY, "utf8");
ok(reserved.length > 0, `the reserved set is non-empty (read ${JSON.stringify(reserved)}) — an empty read would pass clause 2 by iterating nothing. The reader THROWS rather than answering empty on a declaration it cannot parse, which is why this is a floor and not the whole guard`);
ok(reserved.includes("tools/connection_search"), `eve still reserves "tools/connection_search" (read ${JSON.stringify(reserved)}) — if it stopped, OE's own no-op replacement (OPE-1258, in git history) should come back rather than leaving the slot to eve`);
ok(
  /function assertFrameworkToolPolicy\(\w+\)\{if\(\w+\.layer===`framework-default`\)return;/u.test(policySrc),
  `${TOOL_POLICY}'s \`assertFrameworkToolPolicy\` still exempts ONLY the framework-default layer, so every AUTHORED module at a reserved slot throws — replacement as well as sentinel. That throw is what makes clause 2 the live invariant rather than a style rule.`,
);

const authored = readdirSync(SUBAGENT_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.slice(0, -".ts".length))
  .sort();
ok(authored.length > 0, `${SUBAGENT_DIR} authors at least one slot (read ${JSON.stringify(authored)}) — a zero-match read would pass clause 3 vacuously`);
for (const slot of reserved) {
  const name = slot.slice("tools/".length);
  ok(
    !authored.includes(name),
    `${SUBAGENT_DIR}/${name}.ts does NOT exist — eve 0.69.0 reserves "${slot}" and throws on any authored module there, so this file would fail \`eve build\` outright. Its containment now rests on this subagent declaring no connections (clause 4), which is NOT the same guarantee; see this file's header and OPE-2253.`,
  );
}

const ALLOWED_IMPORTS = new Set(["eve/tools"]);
ok(isDisabledToolSentinel(disableTool()), "negative control: eve reads its own disableTool() as a sentinel");

for (const slot of authored) {
  const file = `${SUBAGENT_DIR}/${slot}.ts`;
  const url = pathToFileURL(join(process.cwd(), file));
  const mod = (await import(url.href)) as { default: unknown };
  ok(
    isDisabledToolSentinel(mod.default),
    `${file} is a disableTool() sentinel — every slot this subagent authors must be one, because eve reserves the only slots that ever required a body and a hand-written tool at any other slot is a hand`,
  );

  const source = readFileSync(url, "utf8");
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gmu)].map((m) => m[1]!);
  const sideEffectImports = [...source.matchAll(/^\s*import\s*["']([^"']+)["']/gmu)].map((m) => m[1]!);
  ok(specifiers.length > 0, `${file} parses as a module with imports — a zero-match read here would pass this check vacuously`);
  for (const spec of [...specifiers, ...sideEffectImports]) {
    ok(
      ALLOWED_IMPORTS.has(spec),
      `${file} imports "${spec}", which is not in the zero-hands allowlist [${[...ALLOWED_IMPORTS].join(", ")}]. An import here is a hand: this subagent must reach nothing. If the import is genuinely inert, add it here and say why.`,
    );
  }
  ok(sideEffectImports.length === 0, `${file} has no side-effect imports — one would arm behaviour this test never calls`);
  ok(!/\bfetch\s*\(|\bimport\s*\(|require\s*\(/u.test(source), `${file} performs no dynamic import, require or fetch`);
}

const subagentConnections = join(process.cwd(), SUBAGENT_ROOT, "connections");
ok(
  !existsSync(subagentConnections),
  `${SUBAGENT_ROOT}/connections/ does not exist — this subagent declares no connectors, which is the condition eve's reserved-slot refusal rests on ("they exist only while the agent has connections"). Adding one mounts connector tools into a pass that is supposed to reach nothing.`,
);

const CONNECTION_PROVIDER = join(EVE_ROOT, "dist", "src", "context", "providers", "connection.js");
ok(existsSync(CONNECTION_PROVIDER), `${CONNECTION_PROVIDER} exists — it is the module that decides whether a node gets a connection registry at all`);
const providerSrc = readFileSync(CONNECTION_PROVIDER, "utf8");
ok(
  /getActiveRuntimeNode\(\w+\)\.agent/u.test(providerSrc),
  `${CONNECTION_PROVIDER} reads the connections off the ACTIVE RUNTIME NODE — if it ever read the root's instead, every declared subagent would inherit the root's connectors, which is exactly the hole OPE-1258 closed and which OE can no longer close itself (the slot is reserved)`,
);
ok(
  /getActiveRuntimeNode\(\w+\)\.agent[\s\S]{0,200}?\.connections;?[\s\S]{0,160}?length!==0\|\|[\s\S]{0,160}?\)return\{value:new ConnectionRegistryImpl\(/u.test(providerSrc),
  `${CONNECTION_PROVIDER} still CONSTRUCTS the registry only inside the zero-connections guard — the read, the comparison and the construction in one span. That is what makes "declares no connections" mean "mounts no connection tools" for this subagent; a release that kept the comparison but built the registry unconditionally would mount connector tools into a reasoning pass`,
);
const CONNECTION_TOOLS = join(EVE_ROOT, "dist", "src", "execution", "tools", "connection-tools.js");
ok(existsSync(CONNECTION_TOOLS), `${CONNECTION_TOOLS} exists — it is what mounts connection_search and connection_execute when a registry is present`);
ok(
  /function resolveConnectionTools\(\)\{let \w+=loadContext\(\)\.get\(ConnectionRegistryKey\);if\(\w+===void 0\)return null;/u.test(readFileSync(CONNECTION_TOOLS, "utf8")),
  `${CONNECTION_TOOLS}'s resolveConnectionTools returns null with no registry — the second half of the same guarantee, and the one that decides what the model is actually offered`,
);

const mounted = eveTools.defaultMounted.map((name) => `tools/${name}`).sort();
ok(mounted.length > 0, `the reader names at least one default-mounted slot (read ${JSON.stringify(mounted)}) — a zero-match read would pass this clause by iterating nothing, which is the fail-OPEN shape the reader throws rather than returns`);
for (const slot of mounted.filter((slot) => !reserved.includes(slot))) {
  const name = slot.slice("tools/".length);
  ok(
    authored.includes(name),
    `${SUBAGENT_DIR}/${name}.ts EXISTS — eve mounts "${slot}" on every local node, and an ABSENT file does not mean "no tool": it falls back to eve's framework default, unfenced, with none of the root's hooks behind it. Add the \`disableTool()\` sentinel back.`,
  );
}

ok(
  existsSync(join(process.cwd(), SUBAGENT_ROOT, "hooks", "spend.ts")),
  `${SUBAGENT_ROOT}/hooks/spend.ts exists — hooks are NOT inherited from the root, so without it this subagent's model calls reach neither the usage_events ledger nor the monthly cap, and nothing else in the tree would notice`,
);
ok(
  existsSync(join(process.cwd(), SUBAGENT_ROOT, "instructions.md")),
  `${SUBAGENT_ROOT}/instructions.md exists — a subagent inherits NO instructions (eve's isolation boundary), so without its own file it runs on the framework default prompt instead of the review brief`,
);

console.log(
  `✓ subagent-zero-hands: ${checks} assertions passed — eve reserves ${JSON.stringify(reserved)}, ${SUBAGENT_DIR} authors none of them, ` +
    `its ${authored.length} authored slot(s) are closed sentinels, the subagent declares no connections, ` +
    `eve still scopes its connection registry to the active node (so it mounts none), ` +
    `a sentinel exists for every slot eve mounts by default, ` +
    `and its spend hook and instructions file are present.`,
);

// proves: ROSTER-lint-subagents
