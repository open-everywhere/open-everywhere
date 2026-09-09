import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";
import { SCOPE_KINDS, type ScopeKind } from "./event-model.js";

export type EventRouting = "mapped" | "envelope" | "none";

export interface ProviderEvent {
  readonly event: string;
  readonly routing: EventRouting;
  readonly match: readonly string[];
  readonly scope: readonly ScopeKind[];
  readonly note: string;
}

export interface ProviderEventDeclaration {
  readonly source?: string;
  readonly doc: string;
  readonly events: readonly ProviderEvent[];
}

const DECLARATIONS = processRegistryMap<ProviderEventDeclaration>("provider-events.v1");

export function registerProviderEvents(provider: string, declaration: ProviderEventDeclaration): void {
  if (!admitProviderRegistration(provider, "provider-events")) return;
  DECLARATIONS.set(provider, declaration);
}

export function providerEventsFor(provider: string): ProviderEventDeclaration | undefined {
  return DECLARATIONS.get(provider);
}

export function registeredProviderEventPlatforms(): readonly string[] {
  return [...DECLARATIONS.keys()].sort();
}

export interface ProviderEventProblem {
  readonly provider: string;
  readonly event?: string;
  readonly message: string;
}

export interface NormalizerFacts {
  readonly matchKeys: readonly string[];
  readonly scopeKinds: readonly ScopeKind[];
}

export type NormalizerProbe = ReadonlyMap<string, NormalizerFacts>;

const ROUTINGS: readonly EventRouting[] = ["mapped", "envelope", "none"];

function isEventShape(value: unknown): value is ProviderEvent {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row["event"] !== "string" || typeof row["note"] !== "string") return false;
  if (!ROUTINGS.includes(row["routing"] as EventRouting)) return false;
  return Array.isArray(row["match"]) && Array.isArray(row["scope"]);
}

export function checkProviderEvents(
  declarations: ReadonlyMap<string, unknown>,
  probe: NormalizerProbe = new Map(),
): readonly ProviderEventProblem[] {
  const problems: ProviderEventProblem[] = [];

  for (const provider of [...declarations.keys()].sort()) {
    const declared = declarations.get(provider);
    if (typeof declared !== "object" || declared === null) {
      problems.push({ provider, message: `declared an event inventory that is not an object (got ${typeof declared}).` });
      continue;
    }
    const decl = declared as Record<string, unknown>;
    const source = typeof decl["source"] === "string" ? (decl["source"] as string) : undefined;
    const doc = decl["doc"];
    const events = decl["events"];

    if (typeof doc !== "string" || !doc.startsWith("https://")) {
      problems.push({
        provider,
        message:
          `declares no \`doc\` https URL. Cite the vendor's own event index — every \`event\` name ` +
          `must be findable on it, because an invented event is a routine that waits forever.`,
      });
    }

    if (!Array.isArray(events) || events.length === 0) {
      problems.push({
        provider,
        message: `declares no events. List the vendor event types that could wake a routine, or the bundle has nothing to say here.`,
      });
      continue;
    }

    const facts = source === undefined ? undefined : probe.get(source);
    if (source !== undefined && probe.size > 0 && facts === undefined) {
      problems.push({
        provider,
        message:
          `names \`source: "${source}"\`, but no event normalizer is registered under that key. ` +
          `Register one (\`registerEventNormalizer\`), or drop the \`source\` and declare every row \`routing: "none"\`.`,
      });
    }

    const seen = new Set<string>();
    for (const [index, raw] of events.entries()) {
      if (!isEventShape(raw)) {
        problems.push({
          provider,
          message:
            `event #${index} is not a provider-event row. Each needs \`event\`, \`routing\` ` +
            `("mapped" | "envelope" | "none"), \`match\`, \`scope\` and \`note\`.`,
        });
        continue;
      }
      const row = raw;
      const at = row.event;

      if (at.trim() === "") {
        problems.push({ provider, message: `event #${index} has an empty \`event\` name.` });
        continue;
      }
      if (seen.has(at)) {
        problems.push({ provider, event: at, message: `is declared twice. One row per vendor event.` });
        continue;
      }
      seen.add(at);

      if (row.note.trim() === "") {
        problems.push({
          provider,
          event: at,
          message: `has an empty \`note\`. Say what the event means and — when it is not \`mapped\` — what is missing.`,
        });
        continue;
      }

      const mappings = row.match.length + row.scope.length;
      if (row.routing === "mapped" && mappings === 0) {
        problems.push({
          provider,
          event: at,
          message:
            `is \`routing: "mapped"\` but names no \`match\` key and no \`scope\` kind. A mapping that maps ` +
            `nothing is \`routing: "envelope"\` — the normalizer routes the delivery and reads nothing of its subject.`,
        });
        continue;
      }
      if (row.routing !== "mapped" && mappings > 0) {
        problems.push({
          provider,
          event: at,
          message:
            `is \`routing: "${row.routing}"\` but names ${mappings} mapping(s). Only a \`mapped\` row carries ` +
            `\`match\` keys or \`scope\` kinds — the other two states read nothing of the event's own subject.`,
        });
        continue;
      }
      if (row.routing !== "none" && source === undefined) {
        problems.push({
          provider,
          event: at,
          message:
            `is \`routing: "${row.routing}"\`, but this provider declares no \`source\`. With no registered ` +
            `normalizer nothing routes this event, so every row here is \`routing: "none"\`.`,
        });
        continue;
      }

      if (facts === undefined) continue;
      for (const key of row.match) {
        if (!facts.matchKeys.includes(key)) {
          problems.push({
            provider,
            event: at,
            message:
              `claims a \`${key}\` match key, but the "${source}" normalizer declares matchKeys ` +
              `[${facts.matchKeys.join(", ")}]. A filter naming \`${key}\` is refused at create time, so the ` +
              `row promises a subscription nobody can write — add the key to the normalizer, or drop it here.`,
          });
        }
      }
      for (const kind of row.scope) {
        if (!SCOPE_KINDS.includes(kind)) {
          problems.push({ provider, event: at, message: `claims an unknown scope kind "${String(kind)}".` });
          continue;
        }
        if (!facts.scopeKinds.includes(kind)) {
          problems.push({
            provider,
            event: at,
            message:
              `claims it proves a \`${kind}\` scope step, but the "${source}" normalizer declares scopeKinds ` +
              `[${facts.scopeKinds.join(", ")}]. An \`under\` selector naming \`${kind}\` is refused at create time.`,
          });
        }
      }
    }
  }

  return problems;
}

function escapeCell(text: string): string {
  return text.replace(/\s*\n\s*/gu, " ").replace(/\|/gu, "\\|");
}

function renderRouting(routing: EventRouting): string {
  if (routing === "mapped") return "✅ mapped";
  if (routing === "envelope") return "➖ envelope only";
  return "❌ not routed";
}

export function renderProviderEventTable(provider: string, declaration: ProviderEventDeclaration): string {
  const lines: string[] = [];
  lines.push(
    `**${provider}** — ${declaration.source === undefined ? "no event normalizer" : `source \`${declaration.source}\``}` +
      ` · [vendor event index](${declaration.doc})`,
  );
  lines.push("");
  lines.push("| Vendor event | Routing | Addressable | What it is |");
  lines.push("|---|---|---|---|");
  for (const row of declaration.events) {
    const addressable = [...row.scope.map((k) => `scope \`${k}\``), ...row.match.map((k) => `\`${k}\``)];
    lines.push(
      `| \`${row.event}\` | ${renderRouting(row.routing)} | ${addressable.length > 0 ? addressable.join(", ") : "—"} | ${escapeCell(row.note)} |`,
    );
  }
  return lines.join("\n");
}

export function renderProviderEventInventory(
  declarations: ReadonlyMap<string, ProviderEventDeclaration>,
  providers: readonly string[],
): string {
  const blocks: string[] = [];
  for (const provider of providers) {
    const declared = declarations.get(provider);
    if (declared === undefined) {
      blocks.push(`**${provider}** — ⚠️ no event inventory declared.`);
      continue;
    }
    blocks.push(renderProviderEventTable(provider, declared));
  }
  return blocks.join("\n\n");
}

export function renderProviderEventMatrix(
  declarations: ReadonlyMap<string, ProviderEventDeclaration>,
  providers: readonly string[],
): string {
  const lines: string[] = [];
  let mapped = 0;
  let envelope = 0;
  let none = 0;
  for (const provider of providers) {
    const declared = declarations.get(provider);
    if (declared === undefined) {
      lines.push(`${provider.padEnd(10)}  ? no declaration`);
      continue;
    }
    const counts = { mapped: 0, envelope: 0, none: 0 };
    for (const row of declared.events) counts[row.routing] += 1;
    mapped += counts.mapped;
    envelope += counts.envelope;
    none += counts.none;
    lines.push(
      `${provider.padEnd(10)}  ${String(declared.events.length).padStart(3)} events   ` +
        `mapped ${String(counts.mapped).padStart(2)}   envelope ${String(counts.envelope).padStart(2)}   ` +
        `not routed ${String(counts.none).padStart(2)}   ${declared.source ?? "(no normalizer)"}`,
    );
  }
  lines.push("");
  lines.push(`${mapped + envelope + none} declared vendor events: ${mapped} mapped, ${envelope} envelope-only, ${none} not routed.`);
  return lines.join("\n");
}
