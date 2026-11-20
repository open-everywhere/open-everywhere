import type {
  ParsedPlugin,
  ParsedCommand,
  ParsedMcpServer,
  ParsedAgent,
  OutputFile,
  ExtractionPlan,
  ExtractionReport,
  PluginManifestEntry,
} from "./types.js";
import type { SkillPackageDefinition } from "eve/skills";
import { defaultAgentModelId } from "../model/default-model.js";

const MODEL_ALIASES: Record<string, string> = {
  opus: "anthropic/claude-opus-4.8",
  sonnet: "anthropic/claude-sonnet-4.6",
  haiku: "anthropic/claude-haiku-4.5",
};

export function parseFrontmatter(md: string): {
  data: Record<string, string | string[]>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string | string[]> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let val = mm[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val.startsWith("[") && val.endsWith("]")) {
      data[mm[1]] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else {
      data[mm[1]] = val;
    }
  }
  return { data, body: md.slice(m[0].length) };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ns(plugin: string, item: string): string {
  return `${slugify(plugin)}__${slugify(item)}`;
}

function mapModel(raw: string | undefined, fallback: string): string {
  if (!raw || raw === "inherit") return fallback;
  if (raw.includes("/")) return raw;
  return MODEL_ALIASES[raw.toLowerCase()] ?? fallback;
}

function skillPackageFromMarkdown(md: string, name: string): SkillPackageDefinition {
  const { data, body } = parseFrontmatter(md);
  const description =
    typeof data.description === "string" && data.description
      ? data.description
      : `Use when the task relates to "${name}".`;
  return { description, content: `${body.trim()}\n` };
}

function skillPackageFromCommand(cmd: ParsedCommand): SkillPackageDefinition {
  const description = cmd.description ?? `Use when the user asks to run the "${cmd.slug}" workflow.`;
  const content =
    "> Adapted from the `" +
    cmd.slug +
    "` slash command. There is no slash invocation here — treat the requester's " +
    "message as `$ARGUMENTS` (and `$1`, `$2`… as its whitespace-separated parts).\n\n" +
    `${cmd.body.trim()}\n`;
  return { description, content };
}

function skillContentEntry(pkg: SkillPackageDefinition, files?: readonly { relPath: string; content: string }[]): SkillPackageDefinition {
  const fileMap: Record<string, string> = {};
  for (const f of files ?? []) fileMap[f.relPath] = f.content;
  return Object.keys(fileMap).length ? { ...pkg, files: fileMap } : { ...pkg };
}

function connectionFile(slug: string, server: ParsedMcpServer): string {
  const envVar = tokenEnv(slug, server);
  const description =
    server.description ?? `MCP connector "${slug}" (extracted from a plugin). Review and refine this description.`;
  return `// GENERATED from a plugin MCP server by scripts/extract-plugin.ts — review before trusting.
// An OE connector mount (packages/core/agent/connections/connector-mount.ts), the same form the
// one MCP connection builder (agent/connections/mcp-server-connection.ts) uses. It is a
// defineDynamic tool file: it lists the server's ops and offers each one as a deferred tool named
// <connection>__<op>, whose result reaches the model inside the connector-result fence. It is NOT an
// eve \`defineMcpClientConnection\`: eve's MCP connection runtime has no per-result transform, so
// its results reach the model unfenced, and eve refuses these tool names while a connection of the
// same name is mounted.
//
// Three gates are wired by default:
// - the per-surface HARD gate (assertConnectorGranted) inside getToken;
// - \`connectorApprovalPolicy()\` on \`approval\`: the duplicate-approval guard,
//   then the unattended fence, then per-op read/write tiering where the deployment arms it.
//   🔴 The fence is why this is not a bare \`once()\`: a connector WRITE on an unattended fire
//   must REFUSE, not mint an approval card nobody is there to click, which parks the fire forever;
// - \`seatCut\`, which decides before every model call which ops this seat holds.
// \`auth\` is the resolver form: the gate reads the caller identity straight off
// \`ctx.session.auth\`. Swap getToken for a real credential source in a real deployment.
//
// 🔴 The imports are PACKAGE specifiers, never relative ones. This file lands in a self-hoster's
// \`agent/tools/\`, which holds none of these modules and declares no path alias. Every path is in
// core's exports map, so a consumer that depends on the published package resolves them.
import type { SessionContext } from "eve/context";
import { defineConnectorMount } from "@open-everywhere/core/agent/connections/connector-mount.js";
import { connectorApprovalPolicy } from "@open-everywhere/core/agent/connections/connector-auth.js";
import { assertConnectorGranted } from "@open-everywhere/core/agent/access/connector-scope.js";
import { seatCut } from "@open-everywhere/core/agent/access/seat-cut.js";
import { isListingTokenRequest } from "@open-everywhere/core/agent/connections/connector-listing.js";

export default seatCut(${JSON.stringify(slug)}, defineConnectorMount({
  connection: ${JSON.stringify(slug)},
  url: ${JSON.stringify(server.url)},
  description: ${JSON.stringify(description)},
  auth: async (ctx: SessionContext) => ({
    principalType: "app",
    async getToken(o: unknown) {
      // Refuse surfaces this connector isn't granted to (bundle/resolver decides). A listing
      // probe (before each model call) runs the same gate and writes no audit row: no op ran.
      await assertConnectorGranted(${JSON.stringify(slug)}, ctx.session.auth, { audit: !isListingTokenRequest(o) });
      const token = process.env.${envVar};
      if (!token) throw new Error('connection "${slug}": ${envVar} is not set');
      return { token };
    },
  }),
  approval: connectorApprovalPolicy(),
}));
`;
}

function tokenEnv(slug: string, server: ParsedMcpServer): string {
  for (const v of Object.values(server.headers ?? {})) {
    const m = /\$\{?([A-Z0-9_]+)\}?/.exec(v);
    if (m) return m[1];
  }
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_TOKEN";
}

function subagentAgentFile(dir: string, agent: ParsedAgent, model: string): string {
  const toolsNote = agent.tools?.length
    ? `//\n// NOTE: the source agent restricted tools to: ${agent.tools.join(", ")}.\n` +
      `// Eve subagents get their own tools/ dir; this one currently inherits the\n` +
      `// framework defaults. Add agent/subagents/${dir}/tools/ to narrow it.\n`
    : "";
  const description = agent.description ?? `Specialist subagent "${agent.slug}" (from a plugin).`;
  return `// GENERATED from a plugin agent by scripts/extract-plugin.ts — review before use.
// Eve declared subagent: own context window, persona (instructions.md), and model.
// The model was mapped from the source alias and is adjustable for your gateway.
${toolsNote}import { defineAgent } from "eve";

export default defineAgent({
  description: ${JSON.stringify(description)},
  model: ${JSON.stringify(model)},
});
`;
}

function renderGeneratedSkillModule(
  pluginName: string,
  skillContent: Record<string, SkillPackageDefinition>,
  registryEntry: PluginManifestEntry,
): string {
  return (
    `// GENERATED by \`npm run plugin:extract\` from the "${pluginName}" plugin — do not\n` +
    `// hand-edit. Re-run the extractor to regenerate (deterministic + idempotent: a\n` +
    `// re-run over unchanged source overwrites this file with byte-identical content).\n` +
    `//\n` +
    `// Skills land here as content-registry entries, served through\n` +
    `// agent/skills/scoped.ts's per-surface resolver — never as files under\n` +
    `// agent/skills/, which Eve's own skill discovery (discover/skills.js, compiled\n` +
    `// into node_modules/eve) loads UNCONDITIONALLY for every session and would bypass\n` +
    `// bundle/plugin grant scoping (docs/capabilities/skills-and-plugins.md "Skills are\n` +
    `// scoped per surface"). agent/plugins/generated/index.ts aggregates every file in\n` +
    `// this directory; skill-content.ts / registry.ts import that aggregate and spread\n` +
    `// it alongside any hand-authored entries.\n` +
    `\n` +
    `import type { SkillPackageDefinition } from "eve/skills";\n` +
    `import type { PluginManifestEntry } from "@open-everywhere/core/agent/plugins/types.js";\n` +
    `\n` +
    `export const PLUGIN_NAME = ${JSON.stringify(pluginName)};\n` +
    `\n` +
    `export const SKILL_CONTENT: Record<string, SkillPackageDefinition> = ${JSON.stringify(skillContent, null, 2)};\n` +
    `\n` +
    `export const REGISTRY_ENTRY: PluginManifestEntry = ${JSON.stringify(registryEntry, null, 2)};\n`
  );
}

function toIdentifier(slug: string): string {
  const camel = slug.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
  const safe = /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`;
  return safe || "plugin";
}

export function renderGeneratedIndex(slugs: readonly string[]): string {
  const used = new Set<string>();
  const bindings = slugs.map((slug) => {
    let id = toIdentifier(slug);
    let n = 2;
    while (used.has(id)) id = `${toIdentifier(slug)}${n++}`;
    used.add(id);
    return { slug, id };
  });
  const imports = bindings.map(({ slug, id }) => `import * as ${id} from "./${slug}.js";`).join("\n");
  const skillSpreads = bindings.map(({ id }) => `  ...${id}.SKILL_CONTENT,`).join("\n");
  const registryEntries = bindings.map(({ id }) => `  [${id}.PLUGIN_NAME]: ${id}.REGISTRY_ENTRY,`).join("\n");
  const skillContentBlock = bindings.length ? `{\n${skillSpreads}\n}` : "{}";
  const registryBlock = bindings.length ? `{\n${registryEntries}\n}` : "{}";
  return (
    `// GENERATED by \`npm run plugin:extract\` — DO NOT HAND-EDIT. Rebuilt from scratch\n` +
    `// on every extraction by listing agent/plugins/generated/*.ts (this file excluded)\n` +
    `// and merging each previously extracted plugin's SKILL_CONTENT + REGISTRY_ENTRY.\n` +
    `// Sorted by filename for a stable, idempotent diff. Import GENERATED_SKILL_CONTENT /\n` +
    `// GENERATED_PLUGIN_REGISTRY into skill-content.ts / registry.ts and spread them\n` +
    `// alongside any hand-authored entries (see those files' headers) — empty (no\n` +
    `// plugin extracted yet) is a valid, safe baseline: it contributes nothing.\n` +
    `\n` +
    `import type { SkillPackageDefinition } from "eve/skills";\n` +
    `import type { PluginRegistry } from "@open-everywhere/core/agent/plugins/types.js";\n` +
    (imports ? `${imports}\n` : "") +
    `\n` +
    `export const GENERATED_SKILL_CONTENT: Record<string, SkillPackageDefinition> = ${skillContentBlock};\n` +
    `\n` +
    `export const GENERATED_PLUGIN_REGISTRY: PluginRegistry = ${registryBlock};\n`
  );
}

export function extractPlugin(
  plugin: ParsedPlugin,
  opts: { defaultModel?: string } = {},
): ExtractionPlan {
  const defaultModel = opts.defaultModel ?? defaultAgentModelId();
  const name = plugin.manifest.name;
  const pluginKey = slugify(name);
  const files: OutputFile[] = [];
  const skillContent: Record<string, SkillPackageDefinition> = {};
  const report: ExtractionReport = {
    skills: [],
    commandsAsSkills: [],
    connectors: [],
    subagents: [],
    manual: [],
    notes: [],
  };

  for (const sk of plugin.skills) {
    const skillName = ns(name, sk.slug);
    skillContent[skillName] = skillContentEntry(skillPackageFromMarkdown(sk.skillMd, sk.slug), sk.files);
    report.skills.push(skillName);
  }

  for (const cmd of plugin.commands) {
    const skillName = ns(name, `cmd-${cmd.slug}`);
    skillContent[skillName] = skillContentEntry(skillPackageFromCommand(cmd));
    report.commandsAsSkills.push(skillName);
  }

  for (const srv of plugin.mcpServers) {
    const slug = ns(name, srv.slug);
    if (!srv.url) {
      report.manual.push({
        kind: "mcp",
        name: srv.slug,
        reason:
          "stdio/command MCP server (no url): a connector mount speaks Streamable HTTP only. Host it " +
          "behind a url, or run it as a sandbox tool instead.",
      });
      continue;
    }
    files.push({ path: `agent/tools/${slug}.ts`, content: connectionFile(slug, srv) });
    report.notes.push(
      `MCP server "${srv.slug}" mounts as a connector mount, which speaks Streamable HTTP only. A server that speaks only the legacy SSE transport lists no op: host it behind a Streamable HTTP endpoint.`,
    );
    report.connectors.push(slug);
  }

  for (const ag of plugin.agents) {
    const dir = ns(name, ag.slug);
    const model = mapModel(ag.model, defaultModel);
    files.push({ path: `agent/subagents/${dir}/agent.ts`, content: subagentAgentFile(dir, ag, model) });
    files.push({ path: `agent/subagents/${dir}/instructions.md`, content: `${ag.body.trim()}\n` });
    report.subagents.push(dir);
    if (ag.tools?.length) {
      report.notes.push(
        `subagent ${dir}: source restricted tools to [${ag.tools.join(", ")}]; Eve subagent ` +
          `inherits framework defaults — add a tools/ dir to enforce.`,
      );
    }
    if (!ag.model || ag.model === "inherit") {
      report.notes.push(`subagent ${dir}: no model in source; defaulted to ${model}.`);
    }
  }

  const registryEntry: PluginManifestEntry = {
    ...(report.connectors.length ? { connectors: [...report.connectors] } : {}),
    ...(Object.keys(skillContent).length ? { skills: Object.keys(skillContent) } : {}),
    ...(report.subagents.length ? { subagents: [...report.subagents] } : {}),
  };

  if (Object.keys(skillContent).length > 0) {
    files.push({
      path: `agent/plugins/generated/${pluginKey}.ts`,
      content: renderGeneratedSkillModule(pluginKey, skillContent, registryEntry),
    });
  }

  return { files, skillContent, pluginName: pluginKey, registryEntry, report };
}
