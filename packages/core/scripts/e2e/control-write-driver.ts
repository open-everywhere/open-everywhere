import { devNull } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CORE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CONTROL_ENTRY = fileURLToPath(new URL("../control-mcp.ts", import.meta.url));
const LOCAL_ACTOR = "local-operator";

export const CONTROL_WRITE_CONNECT_TIMEOUT_MS = 180_000;

export function tailStderrLines(text: string, maxLines: number): string {
  const lines = text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return lines.slice(-Math.max(0, maxLines)).join("\n");
}

export function composeControlConnectFailure(cause: unknown, stderrTail: string): string {
  const causeMsg = cause instanceof Error ? cause.message : String(cause);
  const base = "local control writer could not start against the pinned store";
  const tail = stderrTail.length > 0 ? ` — child stderr (last lines): ${stderrTail}` : " — child produced no stderr";
  return `${base}: ${causeMsg}${tail}`;
}

export interface ControlWriteConfig {
  readonly org: string;
  readonly storeEnv: Readonly<Record<string, string>>;
}

export type HaltOwnershipHandle = Readonly<{
  orgWide: false;
  level: "surface";
  scopeKey: string;
  setAt: string;
  setBy?: string;
  setRef?: string;
}>;

export type OrgHaltOwnershipHandle = Readonly<{
  orgWide: true;
  setAt: string;
  setBy?: string;
  setRef?: string;
}>;

export type SpendOwnershipHandle = Readonly<{
  level: "surface";
  scopeKey: string;
  monthlyTokens?: number;
  monthlyUsd?: number;
  expiresAt: number;
  reason: string;
  setBy: string;
}>;

export type OwnedClearResult = "cleared" | "missing" | "changed";

interface OverridesWire {
  readonly org: string;
  readonly spend: readonly SpendOwnershipHandle[];
  readonly halts: readonly (HaltOwnershipHandle | OrgHaltOwnershipHandle)[];
}

export function resolveControlWriteConfig(env: NodeJS.ProcessEnv = process.env):
  | { readonly ok: true; readonly cfg: ControlWriteConfig }
  | { readonly ok: false; readonly missing: readonly string[] } {
  const missing: string[] = [];
  if (env.E2E_CONTROL_LOCAL_WRITE?.trim() !== "1") missing.push("E2E_CONTROL_LOCAL_WRITE=1");
  const org = env.E2E_ORG?.trim();
  if (!org) missing.push("E2E_ORG");
  if (env.OE_OPERATIONAL_PROVIDER?.trim() !== "postgres") missing.push('OE_OPERATIONAL_PROVIDER="postgres"');
  if (!env.DATABASE_URL?.trim()) missing.push("DATABASE_URL");
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    cfg: {
      org: org!,
      storeEnv: {
        OE_OPERATIONAL_PROVIDER: "postgres",
        DATABASE_URL: env.DATABASE_URL!,
        ...(env.OE_CREDENTIAL_ENCRYPTION_KEY ? { OE_CREDENTIAL_ENCRYPTION_KEY: env.OE_CREDENTIAL_ENCRYPTION_KEY } : {}),
      },
    },
  };
}

export class ControlWriteDriver {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
    private readonly org: string,
    private readonly surfaceKey: string,
  ) {}

  static async connect(config: ControlWriteConfig, surfaceKey: string, opts: { readonly connectTimeoutMs?: number } = {}): Promise<ControlWriteDriver> {
    if (!config.org.trim() || !surfaceKey.trim()) throw new Error("control writer needs a non-blank org and exact surfaceKey");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", CONTROL_ENTRY, "--root-env", devNull, "--org", config.org],
      cwd: CORE_DIR,
      env: { ...config.storeEnv, NODE_NO_WARNINGS: "1" },
      stderr: "pipe",
    });
    let stderrBuf = "";
    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
      });
    }
    const client = new Client({ name: "open-everywhere-e2e-control-writer", version: "1" });
    try {
      await client.connect(transport, { timeout: opts.connectTimeoutMs ?? CONTROL_WRITE_CONNECT_TIMEOUT_MS });
      return new ControlWriteDriver(client, transport, config.org, surfaceKey);
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw new Error(composeControlConnectFailure(err, tailStderrLines(stderrBuf, 8)));
    }
  }

  async assertReady(): Promise<void> {
    let listed: Awaited<ReturnType<Client["listTools"]>>;
    try {
      listed = await this.client.listTools();
    } catch {
      throw new Error("local control writer readiness check failed");
    }
    const tools = new Map(listed.tools.map((t) => [t.name, t]));
    for (const required of ["overrides_list", "resume", "set_spend_limit", "clear_spend_limit"]) {
      if (!tools.has(required)) throw new Error(`local control writer is missing required tool ${required}`);
    }
    const properties = (name: string): Record<string, unknown> => {
      const schema = tools.get(name)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
      return schema?.properties ?? {};
    };
    if (!("ifAbsent" in properties("set_spend_limit")) || !("expected" in properties("clear_spend_limit")) || !("expected" in properties("resume"))) {
      throw new Error("local control writer does not advertise the required conditional guards");
    }
    await this.overrides();
  }

  async inspectHalt(): Promise<HaltOwnershipHandle | undefined> {
    return (await this.overrides()).halts.find((h): h is HaltOwnershipHandle => !h.orgWide && h.level === "surface" && h.scopeKey === this.surfaceKey);
  }

  async inspectOrgHalt(): Promise<OrgHaltOwnershipHandle | undefined> {
    return (await this.overrides()).halts.find((h): h is OrgHaltOwnershipHandle => h.orgWide === true);
  }

  async clearOwnedOrgHalt(handle: OrgHaltOwnershipHandle): Promise<OwnedClearResult> {
    if (handle.orgWide !== true || !handle.setAt) throw new Error("org halt ownership handle is not an org-wide halt row");
    const result = await this.callJson("resume", {
      org: this.org,
      orgWide: true,
      expected: { setAt: handle.setAt, ...(handle.setBy ? { setBy: handle.setBy } : {}), ...(handle.setRef ? { setRef: handle.setRef } : {}) },
    });
    if (result.cleared === true) return "cleared";
    return (await this.inspectOrgHalt()) === undefined ? "missing" : "changed";
  }

  async clearOwnedHalt(handle: HaltOwnershipHandle): Promise<OwnedClearResult> {
    this.assertHaltHandle(handle);
    const result = await this.callJson("resume", {
      org: this.org,
      level: "surface",
      scopeKey: this.surfaceKey,
      expected: { setAt: handle.setAt, ...(handle.setBy ? { setBy: handle.setBy } : {}), ...(handle.setRef ? { setRef: handle.setRef } : {}) },
    });
    if (result.cleared === true) return "cleared";
    return (await this.inspectHalt()) === undefined ? "missing" : "changed";
  }

  async inspectSpendLimit(): Promise<SpendOwnershipHandle | undefined> {
    return (await this.overrides()).spend.find((s) => s.level === "surface" && s.scopeKey === this.surfaceKey);
  }

  async setTemporarySpendLimit(input: {
    readonly monthlyTokens?: number;
    readonly monthlyUsd?: number;
    readonly ttlSeconds: number;
    readonly reason: string;
  }): Promise<{ readonly outcome: "created"; readonly handle: SpendOwnershipHandle } | { readonly outcome: "occupied" }> {
    const result = await this.callJson("set_spend_limit", {
      org: this.org,
      level: "surface",
      scopeKey: this.surfaceKey,
      ...(input.monthlyTokens != null ? { monthlyTokens: input.monthlyTokens } : {}),
      ...(input.monthlyUsd != null ? { monthlyUsd: input.monthlyUsd } : {}),
      ttlSeconds: input.ttlSeconds,
      reason: input.reason,
      ifAbsent: true,
    });
    if (result.created !== true) return { outcome: "occupied" };
    const handle: SpendOwnershipHandle = {
      level: "surface",
      scopeKey: this.surfaceKey,
      ...(typeof result.monthlyTokens === "number" ? { monthlyTokens: result.monthlyTokens } : {}),
      ...(typeof result.monthlyUsd === "number" ? { monthlyUsd: result.monthlyUsd } : {}),
      expiresAt: this.numberField(result, "expiresAt"),
      reason: this.stringField(result, "reason"),
      setBy: this.stringField(result, "setBy"),
    };
    return { outcome: "created", handle };
  }

  async clearOwnedSpendLimit(handle: SpendOwnershipHandle): Promise<OwnedClearResult> {
    this.assertSpendHandle(handle);
    const result = await this.callJson("clear_spend_limit", {
      org: this.org,
      level: "surface",
      scopeKey: this.surfaceKey,
      expected: {
        ...(handle.monthlyTokens != null ? { monthlyTokens: handle.monthlyTokens } : {}),
        ...(handle.monthlyUsd != null ? { monthlyUsd: handle.monthlyUsd } : {}),
        expiresAt: handle.expiresAt,
        reason: handle.reason,
        setBy: handle.setBy,
      },
    });
    if (result.cleared === true) return "cleared";
    return (await this.inspectSpendLimit()) === undefined ? "missing" : "changed";
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }

  private async overrides(): Promise<OverridesWire> {
    const value = await this.callJson("overrides_list", { org: this.org });
    if (value.org !== this.org || !Array.isArray(value.spend) || !Array.isArray(value.halts)) {
      throw new Error("local control writer returned an invalid overrides view for the pinned org");
    }
    return value as unknown as OverridesWire;
  }

  private async callJson(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<Client["callTool"]>>;
    try {
      response = await this.client.callTool({ name, arguments: args });
    } catch {
      throw new Error(`local control ${name} transport failed`);
    }
    const text = (response.content as readonly { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
    if (response.isError === true) throw new Error(`local control ${name} refused`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`local control ${name} returned invalid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`local control ${name} returned non-object JSON`);
    return parsed as Record<string, unknown>;
  }

  private assertHaltHandle(handle: HaltOwnershipHandle): void {
    if (handle.orgWide || handle.level !== "surface" || handle.scopeKey !== this.surfaceKey || !handle.setAt) {
      throw new Error("halt ownership handle does not match this driver's exact surface address");
    }
  }

  private assertSpendHandle(handle: SpendOwnershipHandle): void {
    if (handle.level !== "surface" || handle.scopeKey !== this.surfaceKey || handle.setBy !== LOCAL_ACTOR || !handle.reason || !Number.isFinite(handle.expiresAt)) {
      throw new Error("spend ownership handle does not match this driver's exact surface address/actor");
    }
  }

  private stringField(value: Record<string, unknown>, key: string): string {
    const field = value[key];
    if (typeof field !== "string" || !field) throw new Error(`local control response is missing ${key}`);
    return field;
  }

  private numberField(value: Record<string, unknown>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`local control response is missing ${key}`);
    return field;
  }
}
