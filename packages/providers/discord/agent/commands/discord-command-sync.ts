import type { RetryPolicy, SurfaceCommandOutcome, SurfaceCommandScope } from "@open-everywhere/core/agent/adapter-api.js";
import { discordFetch, type DiscordFetchLike } from "../channels/discord-rest.js";
import { buildOeDiscordCommandDefinition } from "./discord-commands.js";
import { discordBotToken } from "../channels/discord-credentials.js";

const BOOT_RETRY: RetryPolicy = { maxAttempts: 1 };

const CALL_TIMEOUT_MS = 1_500;

const RECONCILE_BUDGET_MS = 2_000;

const API_BASE = "https://discord.com/api/v10";

export interface ProjectedOption {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  readonly required: boolean;
  readonly min_value?: number;
  readonly max_value?: number;
  readonly options: readonly ProjectedOption[];
}

export interface ProjectedCommand {
  readonly name: string;
  readonly type: number;
  readonly description: string;
  readonly options: readonly ProjectedOption[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function projectOptions(raw: unknown): readonly ProjectedOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectedOption[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const min = numOrUndefined(entry["min_value"]);
    const max = numOrUndefined(entry["max_value"]);
    out.push({
      name: str(entry["name"]),
      description: str(entry["description"]),
      type: numOrUndefined(entry["type"]) ?? 0,
      required: entry["required"] === true,
      ...(min === undefined ? {} : { min_value: min }),
      ...(max === undefined ? {} : { max_value: max }),
      options: projectOptions(entry["options"]),
    });
  }
  return out;
}

export function projectCommand(raw: unknown): ProjectedCommand | undefined {
  if (!isObject(raw)) return undefined;
  const name = str(raw["name"]);
  if (name.length === 0) return undefined;
  return {
    name,
    type: numOrUndefined(raw["type"]) ?? 1,
    description: str(raw["description"]),
    options: projectOptions(raw["options"]),
  };
}

function canonical(command: ProjectedCommand): string {
  const opt = (o: ProjectedOption): unknown => [o.name, o.description, o.type, o.required, o.min_value ?? null, o.max_value ?? null, o.options.map(opt)];
  return JSON.stringify([command.name, command.type, command.description, command.options.map(opt)]);
}

export interface DiscordCommandDrift {
  readonly changed: boolean;
  readonly reason: string;
}

export function discordCommandDrift(declared: unknown, held: unknown): DiscordCommandDrift {
  const want = projectCommand(declared);
  if (want === undefined) {
    return { changed: false, reason: "the declared command has no name — nothing was compared and nothing will be written" };
  }
  const list = Array.isArray(held) ? held : [];
  const mine = list.map((entry) => projectCommand(entry)).find((entry) => entry !== undefined && entry.name === want.name);
  if (mine === undefined) {
    return { changed: true, reason: `"/${want.name}" is not registered at this scope` };
  }
  if (canonical(mine) !== canonical(want)) {
    return { changed: true, reason: `"/${want.name}" is registered with a different shape` };
  }
  return { changed: false, reason: `"/${want.name}" already matches what this deployment declares` };
}

export interface DiscordCommandSyncDeps {
  readonly fetch?: DiscordFetchLike;
  readonly applicationId?: string;
  readonly botToken?: string;
  readonly timeoutMs?: number;
  readonly budgetMs?: number;
}

interface ScopeResult {
  readonly status: "unchanged" | "updated" | "failed";
  readonly detail: string;
}

async function reconcileOneGuild(
  guildId: string,
  applicationId: string,
  botToken: string,
  deps: DiscordCommandSyncDeps,
  msLeft: () => number,
): Promise<ScopeResult> {
  const declared = buildOeDiscordCommandDefinition();
  const url = `${API_BASE}/applications/${applicationId}/guilds/${guildId}/commands`;
  const headers = { authorization: `Bot ${botToken}`, "content-type": "application/json" };
  const cap = deps.timeoutMs ?? CALL_TIMEOUT_MS;
  const fetchDeps = { ...(deps.fetch ? { fetch: deps.fetch } : {}), retry: BOOT_RETRY };
  const nextTimeout = (): number => Math.min(cap, msLeft());

  if (nextTimeout() <= 0) {
    return { status: "failed", detail: `guild ${guildId}: the boot budget was already spent on an earlier guild — read again on the next start` };
  }

  let held: unknown;
  try {
    const res = await discordFetch("GET /applications/{id}/guilds/{id}/commands", url, { method: "GET", headers, signal: AbortSignal.timeout(nextTimeout()) }, fetchDeps);
    if (!res.ok) return { status: "failed", detail: `guild ${guildId}: the command list read returned ${res.status}` };
    held = await res.json();
  } catch (err) {
    return { status: "failed", detail: `guild ${guildId}: the command list read failed (${err instanceof Error ? err.name : "error"})` };
  }

  const drift = discordCommandDrift(declared, held);
  if (!drift.changed) return { status: "unchanged", detail: `guild ${guildId}: ${drift.reason}` };

  if (nextTimeout() <= 0) {
    return { status: "failed", detail: `guild ${guildId}: ${drift.reason}, and the boot budget was spent before the write — retried on the next start` };
  }

  try {
    const res = await discordFetch(
      "POST /applications/{id}/guilds/{id}/commands",
      url,
      { method: "POST", headers, body: JSON.stringify(declared), signal: AbortSignal.timeout(nextTimeout()) },
      fetchDeps,
    );
    if (!res.ok) return { status: "failed", detail: `guild ${guildId}: ${drift.reason}, and the write returned ${res.status}` };
    return { status: "updated", detail: `guild ${guildId}: ${drift.reason} — registered` };
  } catch (err) {
    return { status: "failed", detail: `guild ${guildId}: ${drift.reason}, and the write failed (${err instanceof Error ? err.name : "error"})` };
  }
}

export async function reconcileDiscordCommands(scope: SurfaceCommandScope, deps: DiscordCommandSyncDeps = {}): Promise<SurfaceCommandOutcome> {
  const applicationId = deps.applicationId ?? process.env.DISCORD_APPLICATION_ID;
  const botToken = deps.botToken ?? (await discordBotToken());
  if (!applicationId || !botToken) {
    return {
      status: "skipped",
      detail: "DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must both be set for this deployment to register its own commands.",
    };
  }

  const deadline = Date.now() + (deps.budgetMs ?? RECONCILE_BUDGET_MS);
  const msLeft = (): number => deadline - Date.now();
  const results: ScopeResult[] = [];
  for (const guildId of scope.scopes) {
    results.push(await reconcileOneGuild(guildId, applicationId, botToken, deps, msLeft));
  }
  const detail = results.map((r) => r.detail).join("; ");
  if (results.some((r) => r.status === "failed")) return { status: "failed", detail };
  if (results.some((r) => r.status === "updated")) return { status: "updated", detail };
  return { status: "unchanged", detail };
}
