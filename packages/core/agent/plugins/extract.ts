import type {
  ParsedPlugin,
  ParsedCommand,
  ParsedMcpServer,
  ParsedAgent,
  OutputFile,
  ExtractionPlan,
  ExtractionReport,
} from "./types.js";

const DEFAULT_SUBAGENT_MODEL = "zai/glm-5.2";

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

function yamlInline(s: string): string {
  return /[:#]/.test(s) ? JSON.stringify(s) : s;
}

function ensureSkillDescription(md: string, name: string): string {
  const { data } = parseFrontmatter(md);
  if (data.description) return md;
  const desc = `Use when the task relates to "${name}".`;
  if (!/^---/.test(md)) return `---\ndescription: ${yamlInline(desc)}\n---\n\n${md.trimStart()}`;
  return md.replace(/^---\r?\n/, `---\ndescription: ${yamlInline(desc)}\n`);
}

function commandSkill(cmd: ParsedCommand): string {
  const desc = cmd.description ?? `Use when the user asks to run the "${cmd.slug}" workflow.`;
  return (
    `---\ndescription: ${yamlInline(desc)}\n---\n\n` +
    "> Adapted from the `" +
    cmd.slug +
    "` slash command. There is no slash invocation here — treat the requester's " +
    "message as `$ARGUMENTS` (and `$1`, `$2`… as its whitespace-separated parts).\n\n" +
    `${cmd.body.trim()}\n`
  );
}

function connectionFile(slug: string, server: ParsedMcpServer): string {
  const envVar = tokenEnv(slug, server);
  const description =
    server.description ?? `MCP connector "${slug}" (extracted from a plugin). Review and refine this description.`;
  return `// GENERATED from a plugin MCP server by scripts/extract-plugin.ts — review before trusting.
// Eve connection (host-side connector plane). The per-surface HARD gate
// (assertConnectorGranted) + once() approval are applied by default, matching
// agent/connections/notion.ts. \`auth\` is the resolver form (eve#299): Eve hands the
// caller's session context to the resolver once per execution step, so the gate reads
// the caller identity straight off \`ctx.session.auth\` — no ALS reach needed. Swap
// getToken for Vercel Connect in a real deployment.
import { defineMcpClientConnection } from "eve/connections";
import { once } from "eve/tools/approval";
import type { SessionContext } from "eve/context";
import { assertConnectorGranted } from "../access/connector-scope.js";

export default defineMcpClientConnection({
  url: ${JSON.stringify(server.url)},
  description: ${JSON.stringify(description)},
  auth: (ctx: SessionContext) => ({
    principalType: "app",
    async getToken() {
      // Refuse surfaces this connector isn't granted to (bundle/resolver decides).
      await assertConnectorGranted(${JSON.stringify(slug)}, ctx.session.auth);
      const token = process.env.${envVar};
      if (!token) throw new Error('connection "${slug}": ${envVar} is not set');
      return { token };
    },
  }),
  approval: once(),
});
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

export function extractPlugin(
  plugin: ParsedPlugin,
  opts: { defaultModel?: string } = {},
): ExtractionPlan {
  const defaultModel = opts.defaultModel ?? DEFAULT_SUBAGENT_MODEL;
  const name = plugin.manifest.name;
  const files: OutputFile[] = [];
  const report: ExtractionReport = {
    skills: [],
    commandsAsSkills: [],
    connectors: [],
    subagents: [],
    manual: [],
    notes: [],
  };

  for (const sk of plugin.skills) {
    const dir = ns(name, sk.slug);
    if (sk.packaged) {
      files.push({ path: `agent/skills/${dir}/SKILL.md`, content: ensureSkillDescription(sk.skillMd, sk.slug) });
      for (const f of sk.files) files.push({ path: `agent/skills/${dir}/${f.relPath}`, content: f.content });
    } else {
      files.push({ path: `agent/skills/${dir}.md`, content: sk.skillMd });
    }
    report.skills.push(dir);
  }

  for (const cmd of plugin.commands) {
    const dir = ns(name, `cmd-${cmd.slug}`);
    files.push({ path: `agent/skills/${dir}/SKILL.md`, content: commandSkill(cmd) });
    report.commandsAsSkills.push(dir);
  }

  for (const srv of plugin.mcpServers) {
    const slug = ns(name, srv.slug);
    if (!srv.url) {
      report.manual.push({
        kind: "mcp",
        name: srv.slug,
        reason:
          "stdio/command MCP server (no url): Eve connections are HTTP/SSE only. Host it " +
          "behind a url, or run it as a sandbox tool instead.",
      });
      continue;
    }
    files.push({ path: `agent/connections/${slug}.ts`, content: connectionFile(slug, srv) });
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

  return { files, report };
}
