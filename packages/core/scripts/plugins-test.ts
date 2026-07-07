import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractPlugin, parseFrontmatter, slugify, renderGeneratedIndex } from "../agent/plugins/extract.js";
import { parsePluginDir } from "../agent/plugins/parse.js";
import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import type { Binding, Bundle } from "../agent/access/bundle.js";
import type { ParsedPlugin, PluginRegistry } from "../agent/plugins/types.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const { data, body } = parseFrontmatter("---\nname: x\ndescription: Hello world.\ntools: [Read, Grep]\n---\n\nBody here.\n");
  ok(data.name === "x", "frontmatter parses a scalar");
  ok(data.description === "Hello world.", "frontmatter parses description");
  ok(Array.isArray(data.tools) && data.tools.length === 2, "frontmatter parses an inline list");
  ok(body.trim() === "Body here.", "frontmatter splits the body");
  ok(parseFrontmatter("no frontmatter").data.description === undefined, "no-frontmatter is handled");
  ok(slugify("Acme Tools!") === "acme-tools", "slugify lowercases + hyphenates");
}

const plugin: ParsedPlugin = {
  manifest: { name: "Acme Tools", version: "1.0.0" },
  skills: [
    {
      slug: "deploy-runbook",
      packaged: true,
      skillMd: "---\nname: deploy-runbook\ndescription: Use when deploying Acme services.\n---\n\nSteps go here.\n",
      files: [{ relPath: "references/checklist.md", content: "# checklist\n" }],
    },
    { slug: "lint", packaged: false, skillMd: "Run the linter before committing.\n", files: [] },
    { slug: "bare", packaged: true, skillMd: "---\nname: bare\n---\n\nDo the thing.\n", files: [] },
  ],
  commands: [
    { slug: "triage", description: "Triage an incoming bug.", body: "Investigate $ARGUMENTS and propose a fix." },
    { slug: "summary", body: "Summarize $ARGUMENTS." },
  ],
  agents: [
    { slug: "researcher", description: "Investigate ambiguous questions.", model: "opus", tools: ["Read", "Grep"], body: "You are a careful researcher." },
    { slug: "scribe", body: "You write docs." },
  ],
  mcpServers: [
    { slug: "search", url: "https://mcp.acme.com/sse", headers: { Authorization: "Bearer ${ACME_API_KEY}" } },
    { slug: "local", command: "node" },
  ],
};

const plan = extractPlugin(plugin);
const { files, report, skillContent, pluginName, registryEntry } = plan;
const byPath = (p: string) => files.find((f) => f.path === p);

{
  ok(pluginName === "acme-tools", "plugin key is the slugified manifest name");

  const deploy = skillContent["acme-tools__deploy-runbook"];
  ok(!!deploy, "packaged skill lands in the skill-content map, namespaced");
  ok(deploy?.description === "Use when deploying Acme services.", "packaged skill description carried over from frontmatter");
  ok(deploy?.markdown === "Steps go here.\n", "packaged skill markdown is the frontmatter-stripped body");
  ok(deploy?.files?.["references/checklist.md"] === "# checklist\n", "skill sibling files copied into the package's files map");

  const lint = skillContent["acme-tools__lint"];
  ok(!!lint && lint.markdown === "Run the linter before committing.\n", "flat skill (no frontmatter) becomes a skill-content entry");
  ok(lint?.description === 'Use when the task relates to "lint".', "flat skill with no description gets one synthesized");

  const bare = skillContent["acme-tools__bare"];
  ok(!!bare && bare.description === 'Use when the task relates to "bare".', "a description is synthesized when the packaged skill lacks one");
  ok(bare?.markdown === "Do the thing.\n", "bare skill's frontmatter is stripped from the markdown");

  ok(report.skills.length === 3, "report counts all three skills");
  ok(!byPath(`agent/skills/${pluginName}__deploy-runbook/SKILL.md`), "no agent/skills/ file is ever emitted for a skill");
}

{
  const triage = skillContent["acme-tools__cmd-triage"];
  ok(!!triage, "command lands in the skill-content map");
  ok(triage?.description === "Triage an incoming bug.", "command description carried over");
  ok(!!triage && triage.markdown.includes("Investigate $ARGUMENTS"), "command body preserved in the markdown");
  ok(!!triage && triage.markdown.includes("slash command"), "command skill explains the $ARGUMENTS mapping");

  const summary = skillContent["acme-tools__cmd-summary"];
  ok(summary?.description === 'Use when the user asks to run the "summary" workflow.', "missing command description is synthesized");
  ok(report.commandsAsSkills.length === 2, "report counts commands-as-skills separately");
  ok(!byPath(`agent/skills/${pluginName}__cmd-triage/SKILL.md`), "no agent/skills/ file is ever emitted for a command-as-skill");
}

{
  const conn = byPath("agent/connections/acme-tools__search.ts");
  ok(!!conn, "url MCP server emitted as an Eve connection");
  ok(!!conn && conn.content.includes("defineMcpClientConnection"), "connection uses defineMcpClientConnection");
  ok(!!conn && conn.content.includes('"https://mcp.acme.com/sse"'), "connection carries the url");
  ok(!!conn && conn.content.includes('assertConnectorGranted("acme-tools__search", ctx.session.auth)'), "connection keeps the per-surface hard gate, wired through the resolver ctx (eve#299)");
  ok(!!conn && conn.content.includes("auth: (ctx: SessionContext) =>"), "connection auth is the resolver form, not a static provider");
  ok(!!conn && conn.content.includes("process.env.ACME_API_KEY"), "token env detected from the server's headers");
  ok(report.connectors.length === 1, "only the url server became a connector");
  ok(report.manual.some((m) => m.kind === "mcp" && m.name === "local"), "the stdio server is reported as MANUAL, not silently dropped");
  ok(!byPath("agent/connections/acme-tools__local.ts"), "no connection emitted for the stdio server");
}

{
  const ag = byPath("agent/subagents/acme-tools__researcher/agent.ts");
  ok(!!ag, "agent emitted as an Eve declared subagent");
  ok(!!ag && ag.content.includes("defineAgent"), "subagent uses defineAgent");
  ok(!!ag && ag.content.includes('"anthropic/claude-opus-4.8"'), "opus alias mapped to a gateway id");
  ok(!!ag && ag.content.includes('"Investigate ambiguous questions."'), "subagent description carried over");
  const instr = byPath("agent/subagents/acme-tools__researcher/instructions.md");
  ok(!!instr && instr.content.includes("careful researcher"), "agent body became instructions.md");
  ok(report.notes.some((nt) => nt.includes("researcher") && nt.includes("Read, Grep")), "restricted tools surfaced as a note");
  const scribe = byPath("agent/subagents/acme-tools__scribe/agent.ts");
  ok(!!scribe && scribe.content.includes('"zai/glm-5.2"'), "subagent with no model defaults to the root model");
  ok(report.notes.some((nt) => nt.includes("scribe") && nt.includes("defaulted")), "the model default is noted");
}

{
  const expectedSkills = [
    "acme-tools__deploy-runbook",
    "acme-tools__lint",
    "acme-tools__bare",
    "acme-tools__cmd-triage",
    "acme-tools__cmd-summary",
  ];
  ok(
    !!registryEntry.skills && expectedSkills.every((s) => registryEntry.skills!.includes(s)) && registryEntry.skills.length === 5,
    "registry entry lists every extracted skill + command-as-skill",
  );
  ok(
    !!registryEntry.connectors && registryEntry.connectors.length === 1 && registryEntry.connectors[0] === "acme-tools__search",
    "registry entry lists the extracted connector",
  );
  ok(
    !!registryEntry.subagents &&
      registryEntry.subagents.length === 2 &&
      registryEntry.subagents.includes("acme-tools__researcher") &&
      registryEntry.subagents.includes("acme-tools__scribe"),
    "registry entry lists both extracted subagents",
  );
}

{
  const generated = byPath("agent/plugins/generated/acme-tools.ts");
  ok(!!generated, "a single generated skill-content module is written per plugin");
  ok(!!generated && generated.content.startsWith("// GENERATED"), "generated module is marked machine-written");
  ok(!!generated && generated.content.includes('export const PLUGIN_NAME = "acme-tools";'), "generated module exports its plugin key");
  ok(!!generated && generated.content.includes("acme-tools__deploy-runbook"), "generated module embeds the skill content");
  ok(!!generated && generated.content.includes("export const REGISTRY_ENTRY"), "generated module exports its registry entry");
  ok(!!generated && !/path:\s*`agent\/skills\//.test(generated.content), "generated module never embeds a raw agent/skills/ write pattern");
  ok(files.filter((f) => f.path.startsWith("agent/plugins/generated/")).length === 1, "exactly one generated file for one plugin");
}

{
  const again = extractPlugin(plugin);
  ok(JSON.stringify(again.skillContent) === JSON.stringify(skillContent), "re-extraction produces identical skill content");
  ok(JSON.stringify(again.registryEntry) === JSON.stringify(registryEntry), "re-extraction produces an identical registry entry");
  ok(JSON.stringify(again.files) === JSON.stringify(files), "re-extraction produces byte-identical output files (stable key/array order)");
}

{
  const registry: PluginRegistry = { [pluginName]: registryEntry };
  const bundles: Bundle[] = [{ name: "acme-grant", plugins: [pluginName] }];
  const bindings: Binding[] = [{ bundle: "acme-grant", scope: { level: "channel", workspace: "T1", channel: "granted-channel" } }];
  const chan = (channel: string): ResolveRequest => ({ mode: "channel", platform: "slack", workspace: "T1", channel });

  const granted = resolveAccess(chan("granted-channel"), bundles, bindings, registry);
  ok(
    granted.skills.length === 5 && granted.skills.includes("acme-tools__deploy-runbook"),
    "a scope whose bundle grants the plugin resolves the extracted skill names",
  );
  for (const name of granted.skills) {
    ok(!!skillContent[name], `every skill the resolver grants ("${name}") actually resolves content in the skill-content map`);
  }

  const ungranted = resolveAccess(chan("other-channel"), bundles, bindings, registry);
  ok(
    ungranted.skills.length === 0 && !ungranted.skills.includes("acme-tools__deploy-runbook"),
    "a sibling scope with NO plugin grant sees none of the extracted skills — the actual security property",
  );
}

{
  const extractSrc = readFileSync(resolve(import.meta.dirname, "../agent/plugins/extract.ts"), "utf-8");
  const cliSrc = readFileSync(resolve(import.meta.dirname, "extract-plugin.ts"), "utf-8");
  const writesAgentSkills = /path:\s*`agent\/skills\//;
  ok(!writesAgentSkills.test(extractSrc), "extract.ts source contains no `path: `agent/skills/...`` write pattern");
  ok(!writesAgentSkills.test(cliSrc), "extract-plugin.ts CLI source contains no `path: `agent/skills/...`` write pattern");
  ok(!files.some((f) => f.path.startsWith("agent/skills/")), "no OutputFile from this extraction ever targets agent/skills/");
}

{
  const empty = renderGeneratedIndex([]);
  ok(empty.includes("GENERATED_SKILL_CONTENT: Record<string, SkillPackageDefinition> = {};"), "empty slug list renders an empty, valid skill-content object");
  ok(empty.includes("GENERATED_PLUGIN_REGISTRY: PluginRegistry = {};"), "empty slug list renders an empty, valid registry object");
  ok(!empty.includes("import * as"), "empty slug list emits no per-plugin imports");

  const two = renderGeneratedIndex(["acme-tools", "fixture"]);
  ok(two.includes('import * as acmeTools from "./acme-tools.js";'), "slug → camelCase import binding");
  ok(two.includes('import * as fixture from "./fixture.js";'), "a second plugin gets its own binding");
  ok(two.includes("...acmeTools.SKILL_CONTENT,") && two.includes("...fixture.SKILL_CONTENT,"), "both plugins' skill content are spread in");
  ok(
    two.includes("[acmeTools.PLUGIN_NAME]: acmeTools.REGISTRY_ENTRY,") && two.includes("[fixture.PLUGIN_NAME]: fixture.REGISTRY_ENTRY,"),
    "both plugins' registry entries are keyed by their own PLUGIN_NAME",
  );

  const collide = renderGeneratedIndex(["acme-tools", "acme_tools"]);
  ok(collide.includes('import * as acmeTools from "./acme-tools.js";'), "first colliding slug keeps the plain identifier");
  ok(collide.includes('import * as acmeTools2 from "./acme_tools.js";'), "second colliding slug gets a disambiguating suffix");
}

{
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-plugin-"));
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
  mkdirSync(join(dir, "skills", "greet"), { recursive: true });
  writeFileSync(join(dir, "skills", "greet", "SKILL.md"), "---\ndescription: Greet the user.\n---\n\nSay hi.\n");
  mkdirSync(join(dir, "commands"), { recursive: true });
  writeFileSync(join(dir, "commands", "ship.md"), "---\ndescription: Ship a release.\n---\n\nTag and push $ARGUMENTS.");
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "critic.md"), "---\nname: critic\ndescription: Critique the plan.\nmodel: sonnet\n---\n\nYou are a sharp critic.");
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://mcp.fixture.dev/sse" } } }));

  const parsed = parsePluginDir(dir);
  ok(parsed.manifest.name === "fixture", "parsePluginDir reads the manifest name");
  ok(parsed.skills.length === 1 && parsed.skills[0].packaged, "parsePluginDir reads a packaged skill");
  ok(parsed.commands.length === 1 && parsed.commands[0].description === "Ship a release.", "parsePluginDir reads a command");
  ok(parsed.agents.length === 1 && parsed.agents[0].model === "sonnet", "parsePluginDir reads an agent + model");
  ok(parsed.mcpServers.length === 1 && parsed.mcpServers[0].url === "https://mcp.fixture.dev/sse", "parsePluginDir reads .mcp.json");

  const fixturePlan = extractPlugin(parsed);
  ok(!!fixturePlan.files.find((f) => f.path === "agent/subagents/fixture__critic/agent.ts"), "round-trip extract emits the subagent");
  ok(fixturePlan.files.find((f) => f.path === "agent/subagents/fixture__critic/agent.ts")!.content.includes("anthropic/claude-sonnet-4.6"), "sonnet alias mapped in round-trip");
  ok(!!fixturePlan.skillContent["fixture__greet"], "round-trip extract puts the packaged skill in the skill-content map");
  ok(fixturePlan.skillContent["fixture__greet"].description === "Greet the user.", "round-trip skill description carried over");
  ok(!!fixturePlan.skillContent["fixture__cmd-ship"], "round-trip extract puts the command-as-skill in the skill-content map");
  ok(!!fixturePlan.files.find((f) => f.path === "agent/plugins/generated/fixture.ts"), "round-trip extract writes exactly one generated skill-content module");
  ok(fixturePlan.pluginName === "fixture", "round-trip plugin key is the slugified manifest name");

  rmSync(dir, { recursive: true, force: true });
}

console.log(
  `\n✓ plugins: ${n} assertions passed (extract: skill-content registry shape, commands→skills, connectors, subagents; registry entry; generated module; idempotence; real-resolver security property; source-scan regression pin; generated/index.ts renderer; disk round-trip)\n`,
);
