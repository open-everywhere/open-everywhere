export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface McpServerConfig {
  readonly url?: string;
  readonly type?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly args?: readonly string[];
}

export interface ParsedSkill {
  readonly slug: string;
  readonly packaged: boolean;
  readonly skillMd: string;
  readonly files: readonly { relPath: string; content: string }[];
}

export interface ParsedCommand {
  readonly slug: string;
  readonly description?: string;
  readonly body: string;
}

export interface ParsedAgent {
  readonly slug: string;
  readonly name?: string;
  readonly description?: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly body: string;
}

export interface ParsedMcpServer {
  readonly slug: string;
  readonly url?: string;
  readonly type?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly description?: string;
}

export interface ParsedPlugin {
  readonly manifest: PluginManifest;
  readonly skills: readonly ParsedSkill[];
  readonly commands: readonly ParsedCommand[];
  readonly agents: readonly ParsedAgent[];
  readonly mcpServers: readonly ParsedMcpServer[];
}

export interface OutputFile {
  readonly path: string;
  readonly content: string;
}

export interface ManualItem {
  readonly kind: string;
  readonly name: string;
  readonly reason: string;
}

export interface ExtractionReport {
  readonly skills: string[];
  readonly commandsAsSkills: string[];
  readonly connectors: string[];
  readonly subagents: string[];
  readonly manual: ManualItem[];
  readonly notes: string[];
}

export interface ExtractionPlan {
  readonly files: OutputFile[];
  readonly report: ExtractionReport;
}
