import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parseFrontmatter } from "./extract.js";
import type {
  ParsedPlugin,
  ParsedSkill,
  ParsedCommand,
  ParsedAgent,
  ParsedMcpServer,
  PluginManifest,
  McpServerConfig,
} from "./types.js";

function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of entries(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function readManifest(dir: string): PluginManifest {
  const p = join(dir, ".claude-plugin", "plugin.json");
  if (existsSync(p)) {
    const json = JSON.parse(readFileSync(p, "utf-8")) as Partial<PluginManifest>;
    if (json.name) return json as PluginManifest;
  }
  return { name: basename(dir) };
}

function readSkills(dir: string): ParsedSkill[] {
  const out: ParsedSkill[] = [];
  for (const e of entries(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const skillMdPath = join(p, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      const files = walkFiles(p)
        .filter((f) => f !== skillMdPath)
        .map((f) => ({ relPath: relative(p, f).split("\\").join("/"), content: readFileSync(f, "utf-8") }));
      out.push({ slug: e, packaged: true, skillMd: readFileSync(skillMdPath, "utf-8"), files });
    } else if (extname(e) === ".md") {
      out.push({ slug: basename(e, ".md"), packaged: false, skillMd: readFileSync(p, "utf-8"), files: [] });
    }
  }
  return out;
}

function readCommands(dir: string): ParsedCommand[] {
  return entries(dir)
    .filter((e) => extname(e) === ".md")
    .map((e) => {
      const { data, body } = parseFrontmatter(readFileSync(join(dir, e), "utf-8"));
      const description = typeof data.description === "string" ? data.description : undefined;
      return { slug: basename(e, ".md"), description, body };
    });
}

function readAgents(dir: string): ParsedAgent[] {
  return entries(dir)
    .filter((e) => extname(e) === ".md")
    .map((e) => {
      const { data, body } = parseFrontmatter(readFileSync(join(dir, e), "utf-8"));
      const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
      let tools: string[] | undefined;
      if (Array.isArray(data.tools)) tools = data.tools;
      else if (typeof data.tools === "string") tools = data.tools.split(",").map((s) => s.trim()).filter(Boolean);
      return {
        slug: basename(e, ".md"),
        name: str(data.name),
        description: str(data.description),
        model: str(data.model),
        tools,
        body,
      };
    });
}

function readMcpServers(dir: string, manifest: PluginManifest): ParsedMcpServer[] {
  const configs: Record<string, McpServerConfig> = { ...manifest.mcpServers };
  const mcpJson = join(dir, ".mcp.json");
  if (existsSync(mcpJson)) {
    const parsed = JSON.parse(readFileSync(mcpJson, "utf-8")) as { mcpServers?: Record<string, McpServerConfig> };
    Object.assign(configs, parsed.mcpServers ?? {});
  }
  return Object.entries(configs).map(([slug, cfg]) => ({
    slug,
    url: cfg.url,
    type: cfg.type,
    headers: cfg.headers,
    command: cfg.command,
  }));
}

export function parsePluginDir(dir: string): ParsedPlugin {
  const manifest = readManifest(dir);
  return {
    manifest,
    skills: readSkills(join(dir, "skills")),
    commands: readCommands(join(dir, "commands")),
    agents: readAgents(join(dir, "agents")),
    mcpServers: readMcpServers(dir, manifest),
  };
}
