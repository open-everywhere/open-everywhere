import { resolveMemoryProviderId } from "../memory/backing-selection.js";
import { resolveOperationalSelection } from "../operational/selection.js";
import { telemetrySwitches } from "../observability/telemetry.js";
import { dataPolicyActive, dataPolicyWords, type ModelDataPolicy } from "../model/data-policy.js";
import type { ModelTargets } from "../model/targets.js";

export type SovereigntyHost = "vercel" | "docker" | "unknown";

export interface SovereigntySettings {
  readonly models: {
    readonly stack: string;
    readonly primary: string;
    readonly force: string;
    readonly dataPolicy: ModelDataPolicy;
    readonly targets: ModelTargets;
  };
  readonly auditExport: { readonly targets: readonly { readonly name: string; readonly format: string; readonly url: string }[] };
  readonly egress: { readonly enforce: boolean; readonly allowUnenforced: boolean };
  readonly memory: { readonly provider: string };
  readonly observability: { readonly logShip: { readonly url: string } };
  readonly telemetry: { readonly enabled: boolean; readonly url: string };
  readonly sandbox: { readonly region: string };
}

export interface SovereigntyInput {
  readonly env: NodeJS.ProcessEnv;
  readonly settings: SovereigntySettings;
  readonly host?: "vercel" | "docker";
  readonly vercelLinked?: boolean;
  readonly vercelRegions?: readonly string[] | undefined;
  readonly stackRoles?: Readonly<Record<string, string>> | undefined;
  readonly chatPlatforms?: readonly string[] | undefined;
  readonly configRemoteHost?: string | undefined;
  readonly transcription?: readonly TranscriptionRouteFact[] | undefined;
  readonly eveScripts?: { readonly disabled: readonly string[]; readonly enabled: readonly string[] } | undefined;
  readonly customWorkflowWorld?: boolean | undefined;
  readonly bareModels?: readonly BareModelFact[] | undefined;
  readonly bareDefaultVia?: string | undefined;
  readonly bareRoutesRegistered?: boolean | "unknown" | undefined;
}

export type BareModelFact =
  | {
      readonly where: string;
      readonly id: string;
      readonly via: string;
      readonly source: "role" | "default";
    }
  | { readonly where: string; readonly id: undefined };

function bareModelWords(bare: readonly BareModelFact[] | undefined, fallback: string | undefined, registered: boolean | "unknown" | undefined): string {
  if (fallback === undefined) return "";
  if (registered === "unknown") return "; bare model ids (declared subagents, eve evaluate()): target unknown, because agent/model/models.ts did not read";
  if (registered === false) {
    return "; bare model ids (declared subagents, eve evaluate()): all via gateway, because agent/model/models.ts does not call registerBareModelRoutes (the 0.8.0 upgrade step)";
  }
  const each = (bare ?? []).map((b) =>
    b.id === undefined ? `${b.where} model unknown (its module did not load)` : b.source === "role" ? `${b.where} via ${b.via}` : `${b.where} ${b.id} via ${b.via} (no role names this model)`,
  );
  const listed = bare === undefined ? "subagents unknown; " : each.length > 0 ? `${each.join(", ")}; ` : "";
  return `; bare model ids (declared subagents, eve evaluate()): ${listed}any other via ${fallback}, the primary role's target`;
}

export interface TranscriptionRouteFact {
  readonly slot: string;
  readonly via: string;
  readonly id: string;
  readonly host?: string | undefined;
}

export interface SovereigntyRow {
  readonly piece: string;
  readonly where: string;
  readonly region: string;
  readonly compellable: string;
  readonly control: string;
}

export interface SovereigntyReport {
  readonly host: SovereigntyHost;
  readonly hostSource: string;
  readonly rows: readonly SovereigntyRow[];
  readonly limits: readonly string[];
}

export const SOVEREIGNTY_PIECES = [
  "compute",
  "memory",
  "transcripts",
  "tool-call logs",
  "run state",
  "audit",
  "credentials",
  "config",
  "gateway",
  "model route",
  "transcription",
  "chat surface",
  "runtime logs",
  "telemetry",
  "other outbound calls",
] as const;

const VERCEL = "Vercel Inc. (US)";
const YOU = "you, and whoever runs the machine or cloud account you deploy to";

function urlHost(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  try {
    return new URL(v).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function postgresHostFacts(databaseUrl: string | undefined): { operator: string; region: string } {
  const host = urlHost(databaseUrl)?.toLowerCase();
  if (host === undefined) return { operator: "unknown (DATABASE_URL does not parse)", region: "unknown" };
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || !host.includes(".")) {
    return { operator: `a Postgres you run beside the app (${YOU})`, region: "where that machine is" };
  }
  const neon = /\.([a-z0-9-]+)\.(aws|azure)\.neon\.tech$/u.exec(host);
  if (neon) return { operator: `Neon (US), on ${neon[2] === "aws" ? "AWS" : "Azure"}`, region: `${neon[2]} ${neon[1]}` };
  const rds = /\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.rds\.amazonaws\.com$/u.exec(host);
  if (rds) return { operator: "Amazon Web Services (US), RDS in your AWS account", region: `aws ${rds[1]}` };
  const supabasePooler = /^aws-\d+-([a-z]{2}-[a-z]+-\d)\.pooler\.supabase\.com$/u.exec(host);
  if (supabasePooler) return { operator: "Supabase (US), on AWS", region: `aws ${supabasePooler[1]}` };
  if (host.endsWith(".supabase.co")) return { operator: "Supabase (US), on AWS", region: "unknown (the host does not name it; read it in the Supabase project)" };
  return { operator: "the operator of your Postgres host (this report does not recognise it)", region: "unknown (read it in your database provider's console)" };
}

const CHAT_OPERATOR: Readonly<Record<string, string>> = {
  slack: "Slack (Salesforce, US)",
  teams: "Microsoft (US)",
  discord: "Discord Inc. (US)",
  github: "GitHub (Microsoft, US)",
  linear: "Linear (US)",
  notion: "Notion Labs (US)",
  "google-chat": "Google (US)",
  email: "your mail provider",
};

function hostOf(input: SovereigntyInput): { host: SovereigntyHost; source: string } {
  if (input.host !== undefined) return { host: input.host, source: "--host" };
  if (input.env.VERCEL === "1") return { host: "vercel", source: "VERCEL=1" };
  if (input.vercelLinked === true) return { host: "vercel", source: ".vercel/project.json" };
  return { host: "unknown", source: "nothing (pass --host vercel or --host docker)" };
}

function byHost(host: SovereigntyHost, vercel: string, docker: string): string {
  if (host === "vercel") return vercel;
  if (host === "docker") return docker;
  return `on Vercel: ${vercel}; self-hosted: ${docker}`;
}

export function sovereigntyReport(input: SovereigntyInput): SovereigntyReport {
  const { env, settings } = input;
  const { host, source } = hostOf(input);
  const rows: SovereigntyRow[] = [];
  const db = env.DATABASE_URL?.trim() ? postgresHostFacts(env.DATABASE_URL) : undefined;
  const vercelRegion =
    input.vercelRegions !== undefined && input.vercelRegions.length > 0
      ? `${input.vercelRegions.join(", ")} (vercel.json regions)`
      : "the Vercel project's function region (not in this repository; read it in the project's settings)";

  rows.push({
    piece: "compute",
    where: byHost(host, "Vercel functions and the Vercel Sandbox", "your container host (the Dockerfile's image)"),
    region: byHost(
      host,
      `functions: ${vercelRegion}; sandbox: ${settings.sandbox.region ? `${settings.sandbox.region} (sandbox.region)` : "Vercel's default (sandbox.region is unset)"}`,
      "where your container runs",
    ),
    compellable: byHost(host, VERCEL, YOU),
    control: "the deploy route you pick (preflight target vercel or docker); sandbox.region pins the Vercel Sandbox",
  });

  const op = resolveOperationalSelection(env);
  const opWhere =
    op.floor === "pglite"
      ? "embedded Postgres (PGlite) on the server's local disk"
      : op.floor === "sqlite"
        ? "a sqlite file on the server's local disk"
        : op.id === "postgres"
          ? "Postgres at DATABASE_URL"
          : `the "${op.id}" operational provider`;
  const opOther = `unknown (the "${op.id}" provider's own config)`;
  const opRegion =
    op.floor !== "none" ? byHost(host, "the function's disk, which does not survive a cold start", "the server's disk") : op.id === "postgres" ? (db?.region ?? "unknown") : opOther;
  const opOperator = op.floor !== "none" ? byHost(host, VERCEL, YOU) : op.id === "postgres" ? (db?.operator ?? "unknown") : opOther;

  const mem = resolveMemoryProviderId(env, input.settings.memory.provider);
  const memWhere: Readonly<Record<string, [string, string, string]>> = {
    postgres: ["Postgres at DATABASE_URL", db?.region ?? "unknown", db?.operator ?? "unknown"],
    git: ["files under `.open-everywhere-memory` (or OE_MEMORY_DIR) on the server (the `git` floor)", byHost(host, "the function's disk", "the server's disk"), byHost(host, VERCEL, YOU)],
    sqlite: ["a sqlite file on the server's disk", byHost(host, "the function's disk", "the server's disk"), byHost(host, VERCEL, YOU)],
    github: ["a GitHub repository", "GitHub's region for that repository", "GitHub (Microsoft, US)"],
    notion: ["a Notion workspace", "Notion's region for that workspace", "Notion Labs (US)"],
  };
  const [mWhere, mRegion, mWho] = memWhere[mem] ?? [`the "${mem}" memory provider`, "unknown", "unknown"];
  rows.push({ piece: "memory", where: mWhere, region: mRegion, compellable: mWho, control: "memory.provider in agent/settings/settings.ts, else DATABASE_URL selects postgres" });

  const WORLD = "experimental.workflow.world in agent/agent.ts";
  const custom = input.customWorkflowWorld === true;
  const workflowWhere = custom
    ? `the workflow world that ${WORLD} names (for example a Postgres world)`
    : byHost(host, "Vercel Workflow (eve's durable session store)", "`.eve/.workflow-data` on the server's disk (eve's local world)");
  const workflowWho = custom ? "the operator of that world's store" : byHost(host, VERCEL, YOU);
  const workflowRegion = custom
    ? "where that world's store runs"
    : byHost(host, "Vercel Workflow's storage region (no config states it; vercel.json regions pins functions only)", "the server's disk");
  const worldControl = custom ? `${WORLD} (set: this report does not read its target)` : `the host; ${WORLD} moves it (unset here)`;
  rows.push({ piece: "transcripts", where: workflowWhere, region: workflowRegion, compellable: workflowWho, control: worldControl });
  rows.push({
    piece: "tool-call logs",
    where: `${workflowWhere}, plus one audit row per consequential act in the operational store`,
    region: workflowRegion,
    compellable: workflowWho === opOperator ? workflowWho : `${workflowWho}; ${opOperator}`,
    control: `${worldControl}; and the operational store below`,
  });
  rows.push({ piece: "run state", where: workflowWhere, region: workflowRegion, compellable: workflowWho, control: worldControl });

  const sinks = settings.auditExport.targets.map((t) => `${t.name} (${t.format}, ${urlHost(t.url) ?? "unparsed url"})`);
  rows.push({
    piece: "audit",
    where: `the operational store: ${opWhere}, hash-chained${sinks.length > 0 ? `; also exported to ${sinks.join(", ")}` : ""}`,
    region: opRegion,
    compellable: sinks.length > 0 ? `${opOperator}; and each SIEM's operator` : opOperator,
    control: "auditExport.targets in agent/settings/settings.ts",
  });

  rows.push({
    piece: "credentials",
    where: `ciphertext in the operational store (${opWhere}); the AES-256-GCM key OE_CREDENTIAL_ENCRYPTION_KEY in the host's environment`,
    region: opRegion,
    compellable:
      host === "vercel"
        ? op.floor !== "none"
          ? `${VERCEL} holds the key and the function disk that holds the ciphertext`
          : op.id === "postgres"
            ? `${opOperator} holds the ciphertext; ${VERCEL} holds the key AND the DATABASE_URL in the project's environment, so Vercel alone can reach both`
            : `${VERCEL} holds the key; the "${op.id}" provider's own config decides who reaches the ciphertext`
        : host === "docker"
          ? `${opOperator} holds the ciphertext; ${YOU} holds the key`
          : `${opOperator} holds the ciphertext; the host that holds the environment holds the key`,
    control: `OE_CREDENTIAL_ENCRYPTION_KEY is ${env.OE_CREDENTIAL_ENCRYPTION_KEY?.trim() ? "set" : "NOT set"}`,
  });

  rows.push({
    piece: "config",
    where: "the app's Git repository (settings, roster, access, identity)",
    region: input.configRemoteHost !== undefined ? `where ${input.configRemoteHost} stores it (no config states a region)` : "unknown (no origin remote)",
    compellable:
      input.configRemoteHost === undefined
        ? "whoever hosts the repository"
        : input.configRemoteHost === "github.com"
          ? "GitHub (Microsoft, US)"
          : `the operator of ${input.configRemoteHost}`,
    control: "a pull request; an upgrade changes it only when you merge one",
  });

  const targets = Object.entries(settings.models.targets).map(([name, t]) => {
    const raw = t.url;
    const source = t.url !== undefined ? `models.targets.${name}.url` : undefined;
    const host = raw === undefined ? undefined : (urlHost(raw) ?? `a ${source} that does not parse as a URL`);
    return { name, host, source, only: t.providers?.only };
  });
  const own = targets.filter((t) => t.host !== undefined);
  const named = (t: (typeof targets)[number]) => (targets.length > 1 ? `${t.name}: ` : "");
  rows.push({
    piece: "gateway",
    where: targets
      .map((t) => (t.host !== undefined ? `${named(t)}your gateway at ${t.host} (${t.source})` : `${named(t)}the Vercel AI Gateway (ai-gateway.vercel.sh)`))
      .join("; "),
    region: own.length === targets.length ? own.map((t) => `where ${t.host} runs`).join("; ") : "Vercel's network (no config states a region)",
    compellable: [...(own.length < targets.length ? [VERCEL] : []), ...own.map((t) => `the operator of ${t.host}`)].join("; "),
    control: "models.targets in agent/settings/settings.ts; the gateway's own team settings set its retention and training terms",
  });

  const policy = settings.models.dataPolicy;
  const roles = input.stackRoles;
  const roleText =
    roles !== undefined && Object.keys(roles).length > 0
      ? ` (${Object.entries(roles)
          .map(([r, id]) => `${r} ${id}`)
          .join(", ")})`
      : "";
  const overrides = [
    ...(settings.models.primary ? [`models.primary ${settings.models.primary}`] : []),
    ...(settings.models.force ? [`models.force ${settings.models.force}`] : []),
  ];
  rows.push({
    piece: "model route",
    where: `stack "${settings.models.stack}"${roleText}${overrides.length > 0 ? `; overridden by ${overrides.join(", ")}` : ""}; data policy: ${dataPolicyWords(policy)}${bareModelWords(input.bareModels, input.bareDefaultVia, input.bareRoutesRegistered)}`,
    region: policy.region !== undefined ? `${policy.region.toUpperCase()} only (models.dataPolicy.region; a call no ${policy.region.toUpperCase()} provider serves fails closed)` : "not pinned (models.dataPolicy.region is unset)",
    compellable: targets.every((t) => t.only !== undefined)
      ? `only ${[...new Set(targets.flatMap((t) => t.only ?? []))].join(", ")} (models.targets providers.only; a call no listed provider serves refuses) (transcription: see its own row)`
      : "the upstream provider the gateway routes each call to, which the gateway's provider allowlist decides; models.targets providers.only narrows it (transcription: see its own row)",
    control: dataPolicyActive(policy) ? "models.stack and models.dataPolicy in agent/settings/settings.ts" : "models.stack; set models.dataPolicy to demand zero retention, no training or a region",
  });

  const tr = input.transcription;
  const refusedVia = (r: TranscriptionRouteFact) => r.via === "deepinfra" && dataPolicyActive(policy);
  const live = (tr ?? []).filter((r) => !refusedVia(r));
  const direct = live.filter((r) => r.via !== "gateway");
  const routeText = (r: TranscriptionRouteFact) =>
    refusedVia(r)
      ? `${r.slot} ${r.id} REFUSED by models.dataPolicy (the deepinfra route cannot carry it)`
      : r.via === "gateway"
        ? `${r.slot} ${r.id} through the gateway`
        : `${r.slot} ${r.id} DIRECT to ${r.host ?? "an unparsed host"} (via ${r.via})`;
  rows.push({
    piece: "transcription",
    where: tr === undefined ? "unknown (agent/model/stacks.ts resolveTranscription did not load)" : tr.length === 0 ? "no transcription route" : tr.map(routeText).join("; "),
    region:
      tr === undefined
        ? "unknown"
        : live.length === 0
          ? "none: no route sends audio"
          : direct.length > 0
            ? "a direct route is outside the gateway, so models.dataPolicy does not reach it"
            : "the gateway's; models.dataPolicy applies to gateway transcription",
    compellable:
      tr === undefined
        ? "unknown"
        : [
            ...(live.some((r) => r.via === "gateway") ? ["the gateway and the provider it routes to"] : []),
            ...direct.map((r) => (r.via === "deepinfra" ? "DeepInfra (US)" : `the operator of ${r.host ?? "the self-hosted server"}`)),
          ].join("; ") || "nobody: no route sends audio",
    control: "the stack's transcription role in agent/model/stacks.ts; voiceClips.enabled: false stops voice clips leaving the deployment",
  });

  const chat = input.chatPlatforms ?? [];
  rows.push({
    piece: "chat surface",
    where: chat.length > 0 ? `the chat platforms the roster selects: ${chat.join(", ")}` : "unknown (no roster.config.ts read)",
    region: "each platform's own data residency for your workspace",
    compellable: chat.length > 0 ? chat.map((c) => CHAT_OPERATOR[c] ?? c).join("; ") : "each chat platform's operator",
    control: "roster.config.ts providers; the messages stay on the platform under your workspace's terms",
  });

  const shipUrl = input.settings.observability.logShip.url.trim();
  const logShip = shipUrl ? (urlHost(shipUrl) ?? "an observability.logShip.url that does not parse as a URL") : undefined;
  rows.push({
    piece: "runtime logs",
    where: `${byHost(host, "Vercel's runtime log store", "your container's log driver")}${logShip !== undefined ? `; shipped to ${logShip} (observability.logShip.url)` : ""}`,
    region: byHost(host, "Vercel's log store (no config states its region)", "where your log driver writes"),
    compellable: `${byHost(host, VERCEL, YOU)}${logShip !== undefined ? `; the operator of ${logShip}` : ""}`,
    control: "observability.logShip.url ships a copy; empty ships nothing",
  });

  const t = telemetrySwitches(input.settings.telemetry, env);
  const tHost = urlHost(t.url) ?? "a telemetry.url that does not parse as a URL";
  rows.push({
    piece: "telemetry",
    where: !t.enabled ? "nowhere: telemetry is OFF" : t.redirected ? `your collector at ${tHost}` : `the project's default collector at ${tHost}`,
    region: !t.enabled ? "none" : t.redirected ? `where ${tHost} runs` : "Vercel (the collector is a Vercel project)",
    compellable: !t.enabled ? "nobody: nothing is sent" : t.redirected ? `the operator of ${tHost}` : `${VERCEL} and Neon (US), which run the default collector for the project's maintainers`,
    control: "telemetry.enabled: false or DO_NOT_TRACK=1 turns it off; telemetry.url redirects it. It never carries content (docs/deploy/telemetry.md)",
  });

  const eve = input.eveScripts;
  const eveText =
    eve === undefined || eve.disabled.length + eve.enabled.length === 0
      ? "eve CLI telemetry: unknown (no package.json script starts eve)"
      : eve.enabled.length > 0
        ? `eve CLI telemetry is ON in the scripts ${eve.enabled.join(", ")} (no EVE_TELEMETRY_DISABLED=1), to telemetry.vercel.com`
        : `eve CLI telemetry is OFF in every script that starts eve (EVE_TELEMETRY_DISABLED=1)`;
  rows.push({
    piece: "other outbound calls",
    where: `the model catalog at ai-gateway.vercel.sh during eve build; ${eveText}; sandbox egress is default-deny${settings.egress.enforce ? "" : " but in DRY-RUN (egress.enforce: false)"}`,
    region: "Vercel's network (no config states a region)",
    compellable: VERCEL,
    control: "`npm run seed:model-catalog` writes the cache; prefix each eve script with EVE_TELEMETRY_DISABLED=1; egress.enforce and egress.allowUnenforced in agent/settings/settings.ts",
  });

  const limits = [
    "It is as sovereign as where you host it: each row's operator can be compelled under its own jurisdiction.",
    "The model provider sees every prompt it serves. models.dataPolicy demands terms of it; it does not move the weights to you.",
    "The chat platform holds every message people send there. This deployment reads it; it does not move it.",
    "This report reads config. It does not probe the hosts, so a region it prints is the one your config states.",
  ];
  if (!settings.egress.enforce || settings.egress.allowUnenforced) {
    limits.push("Sandbox egress is not enforced on every session (egress.enforce false or egress.allowUnenforced true).");
  }
  return { host, hostSource: source, rows, limits };
}

export function renderSovereigntyReport(report: SovereigntyReport): string {
  const lines = [`Sovereignty report — host: ${report.host} (from ${report.hostSource})`, ""];
  for (const r of report.rows) {
    lines.push(`■ ${r.piece}`);
    lines.push(`  where:       ${r.where}`);
    lines.push(`  region:      ${r.region}`);
    lines.push(`  compellable: ${r.compellable}`);
    lines.push(`  control:     ${r.control}`);
  }
  lines.push("", "Limits:", ...report.limits.map((l) => `  • ${l}`), "", "The general map: docs/security/sovereignty.md");
  return `${lines.join("\n")}\n`;
}
