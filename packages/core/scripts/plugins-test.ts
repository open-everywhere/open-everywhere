import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { extractPlugin, parseFrontmatter, slugify } from "../agent/plugins/extract.js";
import { parsePluginDir } from "../agent/plugins/parse.js";
import type { ParsedPlugin } from "../agent/plugins/types.js";

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

const { files, report } = extractPlugin(plugin);
const byPath = (p: string) => files.find((f) => f.path === p);

{
  const sk = byPath("agent/skills/acme-tools__deploy-runbook/SKILL.md");
  ok(!!sk, "packaged skill emitted under namespaced dir");
  ok(!!byPath("agent/skills/acme-tools__deploy-runbook/references/checklist.md"), "skill sibling files copied");
  ok(!!byPath("agent/skills/acme-tools__lint.md"), "flat skill emitted as a .md file");
  const bare = byPath("agent/skills/acme-tools__bare/SKILL.md");
  ok(!!bare && /description:/.test(bare.content), "a description is injected when the skill lacks one");
  ok(report.skills.length === 3, "report counts all three skills");
}

{
  const triage = byPath("agent/skills/acme-tools__cmd-triage/SKILL.md");
  ok(!!triage, "command emitted as a skill");
  ok(!!triage && triage.content.includes("description: Triage an incoming bug."), "command description carried over");
  ok(!!triage && triage.content.includes("Investigate $ARGUMENTS"), "command body preserved");
  ok(!!triage && triage.content.includes("slash command"), "command skill explains the $ARGUMENTS mapping");
  const summary = byPath("agent/skills/acme-tools__cmd-summary/SKILL.md");
  ok(!!summary && /description: Use when the user asks to run the "summary" workflow\./.test(summary.content), "missing command description is synthesized");
  ok(report.commandsAsSkills.length === 2, "report counts commands-as-skills separately");
}

{
  const conn = byPath("agent/connections/acme-tools__search.ts");
  ok(!!conn, "url MCP server emitted as an Eve connection");
  ok(!!conn && conn.content.includes("defineMcpClientConnection"), "connection uses defineMcpClientConnection");
  ok(!!conn && conn.content.includes('"https://mcp.acme.com/sse"'), "connection carries the url");
  ok(!!conn && conn.content.includes('assertConnectorGranted("acme-tools__search")'), "connection keeps the per-surface hard gate");
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

  const plan = extractPlugin(parsed);
  ok(!!plan.files.find((f) => f.path === "agent/subagents/fixture__critic/agent.ts"), "round-trip extract emits the subagent");
  ok(plan.files.find((f) => f.path === "agent/subagents/fixture__critic/agent.ts")!.content.includes("anthropic/claude-sonnet-4.6"), "sonnet alias mapped in round-trip");

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ plugins: ${n} assertions passed (extract: skills, commands→skills, connectors, subagents; + disk round-trip)\n`);
