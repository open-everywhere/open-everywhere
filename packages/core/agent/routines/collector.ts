import { wrapUntrusted } from "../access/untrusted.js";
import { classifyConnectorOpTier } from "../access/consequence.js";
import { connectorToolPermissionKind, routinePermissionKind } from "../approvals/session-grant.js";

export interface RoutineCollectorDef {
  readonly name: string;
  readonly tool: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly describe: string;
  readonly timeoutMs?: number;
  readonly personal?: true;
}

const COLLECTOR_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const MAX_ROUTINE_COLLECTORS = 4;

export const COLLECTOR_BODY_MAX_CHARS = 4000;

export const COLLECTOR_DETAIL_MAX_CHARS = 300;

export const COLLECTOR_DEFAULT_TIMEOUT_MS = 10_000;

export const COLLECTOR_MAX_TIMEOUT_MS = 60_000;

let REGISTERED: ReadonlyMap<string, RoutineCollectorDef> = new Map();

export function assertCollectorDeclarable(def: RoutineCollectorDef): void {
  if (!COLLECTOR_NAME.test(def.name)) {
    throw new Error(
      `Routine collector name "${def.name}" is not usable: use lowercase letters, digits, ".", "-" or "_", 1–64 characters.`,
    );
  }
  if (def.describe.trim().length === 0) {
    throw new Error(`Routine collector "${def.name}" needs a one-line \`describe\` — it is what a human reads on the routine's card.`);
  }
  if (routinePermissionKind(collectorDeclaration(def)) === null) {
    throw new Error(
      `Routine collector "${def.name}" names "${def.tool}", which is not a declarable tool permission. ` +
        `Name the tool exactly as it is called, with its connection segment — e.g. "notion__search". ` +
        `A bare verb or a connection slug on its own names no tool.`,
    );
  }
  if (def.timeoutMs !== undefined && (!Number.isInteger(def.timeoutMs) || def.timeoutMs < 1 || def.timeoutMs > COLLECTOR_MAX_TIMEOUT_MS)) {
    throw new Error(
      `Routine collector "${def.name}" declares a timeout of ${def.timeoutMs}ms, which is not usable: give a whole number of milliseconds between 1 and ${COLLECTOR_MAX_TIMEOUT_MS}. ` +
        `A collector runs inline on the dispatcher's tick, so its deadline is a bound on every OTHER routine's lateness too.`,
    );
  }
  if (classifyConnectorOpTier(def.tool) !== "read") {
    throw new Error(
      `Routine collector "${def.name}" names "${def.tool}", which this build does not classify as a READ ` +
        `(access/consequence.ts). A collector runs unattended, before the session exists, so it may only READ — ` +
        `and an unrecognised verb fails closed to the delete tier, so a tool whose name does not read as a read is refused here.`,
    );
  }
}

export function registerRoutineCollectors(defs: readonly RoutineCollectorDef[]): void {
  const next = new Map<string, RoutineCollectorDef>();
  for (const def of defs) {
    assertCollectorDeclarable(def);
    if (next.has(def.name)) throw new Error(`Routine collector "${def.name}" is declared twice — one name, one read.`);
    next.set(def.name, def);
  }
  REGISTERED = next;
}

export function resolveRoutineCollector(name: string): RoutineCollectorDef | undefined {
  return REGISTERED.get(name);
}

export function listRoutineCollectors(): readonly RoutineCollectorDef[] {
  return [...REGISTERED.values()];
}

export function collectorDeclaration(def: Pick<RoutineCollectorDef, "tool">): string {
  return `tool:${def.tool}`;
}

export function validateRoutineCollectors(names: readonly string[], declaredPermissions: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    if (out.includes(name)) continue;
    const def = resolveRoutineCollector(name);
    if (!def) {
      const menu = listRoutineCollectors();
      throw new Error(
        `"${name}" is not a pre-run collector this deployment declares. ` +
          (menu.length === 0
            ? "This deployment declares none at all, so a routine cannot name one — leave `collectors` out."
            : `The declared collectors are: ${menu.map((d) => `"${d.name}" (${d.describe})`).join(", ")}.`),
      );
    }
    const needed = collectorDeclaration(def);
    if (!declaredPermissions.map((d) => d.trim()).includes(needed)) {
      throw new Error(
        `The "${name}" collector reads with the "${def.tool}" tool, so this routine has to declare "${needed}" in its ` +
          `permissions — a collector runs under the routine's declared permission and nothing wider. Add it, or drop the collector.`,
      );
    }
    out.push(name);
  }
  if (out.length > MAX_ROUTINE_COLLECTORS) {
    throw new Error(
      `A routine may name at most ${MAX_ROUTINE_COLLECTORS} pre-run collectors (got ${out.length}) — every one of them runs before the fire, on the dispatcher's own tick.`,
    );
  }
  return out;
}

export type RoutineCollectorReader = (input: {
  readonly org: string;
  readonly routineId: string;
  readonly collector: RoutineCollectorDef;
  readonly signal: AbortSignal;
  readonly forPrincipal?: string;
}) => Promise<string>;

let READER: RoutineCollectorReader | undefined;
let READER_PERSONAL = false;

export function registerRoutineCollectorReader(reader: RoutineCollectorReader | undefined, opts: { readonly personal?: boolean } = {}): void {
  READER = reader;
  READER_PERSONAL = reader !== undefined && opts.personal === true;
}

export type CollectedInput =
  | { readonly name: string; readonly ok: true; readonly describe: string; readonly body: string; readonly truncated: boolean }
  | { readonly name: string; readonly ok: false; readonly failure: string; readonly detail?: string };

export type CollectorFailure =
  | "unknown_collector"
  | "permission_refused"
  | "no_reader"
  | "timeout"
  | "read_failed"
  | "not_personal"
  | "collection_failed";

export function describeCollectorFailure(failure: CollectorFailure, configValue?: string | number): string {
  switch (failure) {
    case "unknown_collector":
      return "this deployment declares no collector by that name";
    case "permission_refused":
      return `this routine holds no declared permission for ${configValue ? `"${configValue}"` : "that tool"}`;
    case "no_reader":
      return "this deployment has no collector reader wired";
    case "timeout":
      return `the read did not answer within ${configValue ?? COLLECTOR_DEFAULT_TIMEOUT_MS}ms and was abandoned`;
    case "read_failed":
      return "the read failed";
    case "not_personal":
      return "this read is not declared to run as one person";
    case "collection_failed":
      return "the pre-fire collection step broke before this read ran";
  }
}

class CollectorDeadline extends Error {}

async function readWithDeadline(reader: RoutineCollectorReader, input: { org: string; routineId: string; collector: RoutineCollectorDef; forPrincipal?: string }): Promise<string> {
  const ms = input.collector.timeoutMs ?? COLLECTOR_DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader({ ...input, signal: ac.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new CollectorDeadline(`collector "${input.collector.name}" exceeded ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function capBody(body: string): { body: string; truncated: boolean } {
  return body.length <= COLLECTOR_BODY_MAX_CHARS
    ? { body, truncated: false }
    : { body: body.slice(0, COLLECTOR_BODY_MAX_CHARS), truncated: true };
}

export async function collectRoutineInputs(input: {
  readonly org: string;
  readonly routineId: string;
  readonly names: readonly string[];
  readonly heldKinds: readonly string[];
  readonly forPrincipal?: string;
}): Promise<readonly CollectedInput[]> {
  const out: CollectedInput[] = [];
  for (const name of input.names) {
    const def = resolveRoutineCollector(name);
    if (!def) {
      out.push({ name, ok: false, failure: describeCollectorFailure("unknown_collector") });
      continue;
    }
    if (!input.heldKinds.includes(connectorToolPermissionKind(def.tool))) {
      out.push({ name, ok: false, failure: describeCollectorFailure("permission_refused", def.tool) });
      continue;
    }
    const reader = READER;
    if (!reader) {
      out.push({ name, ok: false, failure: describeCollectorFailure("no_reader") });
      continue;
    }
    if (input.forPrincipal !== undefined && (def.personal !== true || !READER_PERSONAL)) {
      out.push({ name, ok: false, failure: describeCollectorFailure("not_personal") });
      continue;
    }
    try {
      const raw = await readWithDeadline(reader, {
        org: input.org,
        routineId: input.routineId,
        collector: def,
        ...(input.forPrincipal !== undefined ? { forPrincipal: input.forPrincipal } : {}),
      });
      const { body, truncated } = capBody(raw);
      out.push({ name, ok: true, describe: def.describe, body, truncated });
    } catch (err) {
      if (err instanceof CollectorDeadline) {
        out.push({ name, ok: false, failure: describeCollectorFailure("timeout", def.timeoutMs ?? COLLECTOR_DEFAULT_TIMEOUT_MS) });
        continue;
      }
      out.push({ name, ok: false, failure: describeCollectorFailure("read_failed"), detail: String(err).slice(0, COLLECTOR_DETAIL_MAX_CHARS) });
    }
  }
  return out;
}

export const COLLECTED_BLOCK_TAG = "[collected]";

export function collectionCarriesData(results: readonly CollectedInput[]): boolean {
  return results.some((r) => r.ok);
}

export function renderCollectedBlock(results: readonly CollectedInput[]): string {
  if (results.length === 0) return "";
  const lines: string[] = [
    `${COLLECTED_BLOCK_TAG} These reads ran before this fire started, so you are looking at current inputs, ` +
      `not remembered ones. Each line below says whether its read WORKED. A read that failed returned NOTHING — ` +
      `do not treat its absence as an observation, and say so if the run needed it.`,
  ];
  const bodies: string[] = [];
  for (const r of results) {
    if (r.ok) {
      lines.push(`  • ${r.name} — ${r.describe}: collected${r.truncated ? ` (truncated at ${COLLECTOR_BODY_MAX_CHARS} characters)` : ""}`);
      bodies.push(`### ${r.name}\n${r.body}`);
    } else {
      lines.push(`  • ${r.name} — NOT COLLECTED: ${r.failure}`);
    }
  }
  const head = lines.join("\n");
  if (bodies.length === 0) return head;
  return `${head}\n\n${wrapUntrusted(bodies.join("\n\n"), { source: "routine collector" })}`;
}
