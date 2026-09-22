import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditWireEntry } from "../e2e/audit-read.js";
import { wireNeonOperationalStore, rotateUnifiedWindow } from "../e2e/rotate-window-lib.js";
import { isModelUsable, type ModelPolicy } from "../../agent/model/policy.js";
import { modelAllowList, PRIMARY_MODEL } from "../../../../agent/model/models.js";
import type { ModelReasoning } from "../../agent/memory/domain.js";
import type { OperationalStore, DomainModelRow } from "../../agent/operational/store.js";
import type { MemorySilo } from "../../agent/memory/silo.js";
import { sourceLabel } from "../../agent/memory/listing.js";
import { controlPartition } from "../../agent/memory/partition.js";
import { siloTier } from "../../agent/memory/store.js";
import { deploymentOrg } from "../../agent/identity/deployment-identity.js";
import {
  TARGET, READ, INJECT, sleep, injectWake, auditSince, dS,
  readTranscript, extractMemoryPathReads, terminalProse, replyText, scoreNavigation, siloOfPath,
  transcriptServedWake, attributeRowInFamily, traceDelegation,
  NO_REPLY_ACTIONS, REPLIED_ACTIONS, type RowAttribution, type DelegationTrace,
  type Injection, type InjectBody,
} from "./memory-eval-harness.js";
import { scoreRecall, scoreAbstention, statedWithoutDisclaimer, terminalVerdict } from "./memory-eval.js";
import { buildTopology, type Topology, type PlantedFact, type SiloSpec, type PlantEntry } from "./seed-silo.js";

const ALLOW_POLICY: ModelPolicy = { allow: modelAllowList(), reasoningCeiling: "high" };

const REPLY_TIMEOUT_MS = 300_000;
const POLL_MS = 7_000;
const SETTLE_MS = 12_000;

const SLACK_SURFACE = (process.env.EVAL_MEM_SLACK_SURFACE ?? process.env.EVAL_SLACK_SURFACE ?? "").trim();
const SLACK_CHANNEL_ID = SLACK_SURFACE.split("/").slice(2).join("/");

export const TYPED_SILOS: readonly SiloSpec[] = [
  {
    name: "ledger-db",
    provider: "postgres",
    description: "payments ledger decisions — settlement timing, reconciliation, disputes",
    descriptionQuality: "clear",
    shape: "nested",
    tree: [
      { dir: "settlement", purpose: "settlement timing + reconciliation", children: ["timing", "recon", "fees"] },
      { dir: "disputes", purpose: "chargebacks + dispute SLAs", children: ["chargebacks", "sla"] },
    ],
  },
  {
    name: "runbooks-git",
    provider: "git",
    description: "service runbooks and deploy topology, kept in the ops repo",
    descriptionQuality: "clear",
    shape: "repo-tree",
    tree: [
      { dir: "services", purpose: "per-service runbooks + ownership", children: ["gateway", "ledger", "webhooks"] },
      { dir: "deploy", purpose: "rollout + rollback procedure", children: ["rollout", "rollback"] },
    ],
  },
  {
    name: "scratch-db",
    provider: "sqlite",
    description: "scratch",
    descriptionQuality: "vague",
    shape: "flat",
  },
  {
    name: "policy-cache",
    provider: "postgres",
    description: "company policy — security, data retention, leave (read-only projection)",
    descriptionQuality: "clear",
    shape: "nested",
    readOnly: true,
    skill: "notion",
    tree: [
      { dir: "security", purpose: "access, incident, data policy", children: ["access", "data"] },
      { dir: "hr", purpose: "leave, benefits", children: ["leave", "benefits"] },
    ],
  },
];

export const TYPED_PLANT_PLAN: readonly PlantEntry[] = [
  { silo: "runbooks-git", path: "services/gateway/runbook.md", topic: "gateway rollback", distractorSilo: "ledger-db" },
  { silo: "ledger-db", path: "settlement/timing/decisions.md", topic: "settlement timing", distractorSilo: "runbooks-git" },
  { silo: "ledger-db", path: "disputes/chargebacks/decisions.md", topic: "chargeback window", distractorSilo: "scratch-db" },
];

export const CACHE_FACT: PlantedFact = {
  id: "CACHE",
  silo: "policy-cache",
  path: "hr/leave/policy.md",
  depth: 2,
  question: "how many days of leave can we carry over, and under which ref? reply with both.",
  needles: ["5 days", "R-LEAVE-05"],
  topic: "leave carry-over",
};
const CACHE_FACT_FILE =
  `# leave carry-over — policy\n\n` +
  `- 2029-11-04: leave carry-over is capped at 5 days per person per year, ref R-LEAVE-05. ` +
  `Update via the notion tools — this cache is read-only.\n`;
const CACHE_DISTRACTOR = {
  forFact: "CACHE",
  silo: "scratch-db",
  path: "leave-carry-over-notes.md",
  wrongNeedles: ["9 days", "R-LEAVE-99"],
} as const;
const CACHE_DISTRACTOR_FILE =
  `# leave carry-over (stray note)\n\n` +
  `- someone mentioned "leave carry-over" here once: an OLD/WRONG value 9 days, ref R-LEAVE-99. ` +
  `This is NOT the locked decision — the real one lives in the policy-cache silo.\n`;

export interface TypedTopology extends Topology {
  readonly labels: ReadonlyMap<string, string>;
}

export function buildTypedTopology(opts: { seed?: number; size?: string; org?: string } = {}): TypedTopology {
  const base = buildTopology({ ...opts, silos: TYPED_SILOS, plantPlan: TYPED_PLANT_PLAN });

  const cache = base.silos.find((s) => s.name === CACHE_FACT.silo);
  const scratch = base.silos.find((s) => s.name === CACHE_DISTRACTOR.silo);
  if (cache) cache.files[CACHE_FACT.path] = CACHE_FACT_FILE;
  if (scratch) scratch.files[CACHE_DISTRACTOR.path] = CACHE_DISTRACTOR_FILE;

  const labels = new Map<string, string>();
  for (const s of base.silos) {
    const silo: MemorySilo = { name: s.name, provider: s.provider, ...(s.readOnly ? { readOnly: true } : {}) };
    labels.set(s.name, sourceLabel(silo));
  }

  return {
    ...base,
    facts: cache ? [...base.facts, CACHE_FACT] : base.facts,
    distractors: scratch ? [...base.distractors, CACHE_DISTRACTOR] : base.distractors,
    labels,
  };
}

export type RetrievalAxis =
  | "cross-type-cued"
  | "cross-type-uncued"
  | "same-label"
  | "read-only-projection"
  | "absent";

export interface RetrievalProbe {
  readonly id: string;
  readonly axis: RetrievalAxis;
  readonly tag: string;
  readonly text: string;
  readonly expected: string;
  readonly factId?: string;
}

export const SOURCE_CUE: Readonly<Record<string, string>> = {
  "runbooks-git": "check the ops repo",
  "ledger-db": "check the ledger decisions database",
};

const AXIS_BY_PLANT: Readonly<Record<string, RetrievalAxis>> = {
  "runbooks-git:services/gateway/runbook.md": "cross-type-cued",
  "ledger-db:settlement/timing/decisions.md": "cross-type-uncued",
  "ledger-db:disputes/chargebacks/decisions.md": "same-label",
};

export function buildRetrievalBattery(topology: TypedTopology): RetrievalProbe[] {
  const probes: RetrievalProbe[] = [];
  const planted = topology.facts.filter((f) => f.id !== CACHE_FACT.id);

  planted.forEach((f, i) => {
    const id = `T${i + 1}`;
    const axis = AXIS_BY_PLANT[`${f.silo}:${f.path}`] ?? "cross-type-uncued";
    const cue = axis === "cross-type-cued" ? SOURCE_CUE[f.silo] : undefined;
    const nearMissSilo = topology.distractors.find((d) => d.forFact === f.id)?.silo;
    const nearMissLabel = nearMissSilo ? topology.labels.get(nearMissSilo) ?? "another source" : "another source";
    probes.push({
      id,
      axis,
      tag: `RQ:${id}:${f.silo}`,
      text: `open everywhere — ${cue ? `${cue}: ` : ""}${f.question}`,
      expected:
        nearMissLabel === topology.labels.get(f.silo)
          ? `recall from ${f.silo} — its near-miss sits in ${nearMissSilo}, which carries the SAME "${nearMissLabel}" label`
          : `recall from ${f.silo} (${topology.labels.get(f.silo)}) — its near-miss sits in a "${nearMissLabel}"-labelled silo`,
      factId: f.id,
    });
  });

  const cache = topology.facts.find((f) => f.id === CACHE_FACT.id);
  if (cache) {
    const cacheProbeId = `T${planted.length + 1}`;
    probes.push({
      id: cacheProbeId,
      axis: "read-only-projection",
      tag: `RQ:${cacheProbeId}:${cache.silo}`,
      text: `open everywhere — ${cache.question}`,
      expected: `recall from the read-only ${cache.silo} projection — and never claim to have edited it`,
      factId: cache.id,
    });
  }

  const absentId = `T${probes.length + 1}`;
  probes.push({
    id: absentId,
    axis: "absent",
    tag: `RQ:${absentId}:absent`,
    text: `open everywhere — ${topology.absentProbe.question}`,
    expected: "ABSTAIN — the answer is in no silo, of any type",
  });

  return probes;
}

export interface RetrievalObservation {
  readonly reads: readonly string[];
  readonly answer: string | null;
  readonly replied: boolean;
}

export type RetrievalVerdict = "HIT" | "LEAK" | "MISS" | "ABSTAINED" | "UNREACHED";

export interface RetrievalScore {
  readonly id: string;
  readonly axis: RetrievalAxis;
  readonly truthSilo: string | null;
  readonly truthLabel: string | null;
  readonly verdict: RetrievalVerdict;
  readonly reached: boolean;
  readonly routedRightSilo: boolean | null;
  readonly routedRightLabel: boolean | null;
  readonly wrongLabelReads: number;
  readonly silosTouched: readonly string[];
  readonly labelsTouched: readonly string[];
  readonly readsToAnswerFile: number | null;
  readonly totalReads: number;
  readonly claimedCacheWrite: boolean;
  readonly note: string;
}

const WRITE_CLAIM_PHRASES = ["i updated", "i've updated", "i have updated", "i edited", "i've edited", "updated the policy", "saved it to", "wrote it to", "i changed"];
const NEGATION_MARKERS = ["can't", "cannot", "could not", "couldn't", "did not", "didn't", "won't", "will not", "unable", "read-only", "read only", "not allowed", "blocked", "instead of", "rather than", "without"];

export function claimedWrite(text: string | null): boolean {
  if (!text) return false;
  return WRITE_CLAIM_PHRASES.some((p) => statedWithoutDisclaimer(text, p, NEGATION_MARKERS));
}

export function scoreRetrievalProbe(probe: RetrievalProbe, topology: TypedTopology, obs: RetrievalObservation): RetrievalScore {
  const fact = probe.factId ? topology.facts.find((f) => f.id === probe.factId) ?? null : null;
  const truthSilo = fact?.silo ?? null;
  const truthLabel = truthSilo ? topology.labels.get(truthSilo) ?? null : null;
  const wrongNeedles = probe.factId ? topology.distractors.filter((d) => d.forFact === probe.factId).flatMap((d) => d.wrongNeedles) : [];

  const silos = obs.reads.map(siloOfPath).filter((s): s is string => s !== null);
  const silosTouched: string[] = [];
  for (const s of silos) if (!silosTouched.includes(s)) silosTouched.push(s);
  const labelsTouched: string[] = [];
  for (const s of silosTouched) {
    const l = topology.labels.get(s);
    if (l && !labelsTouched.includes(l)) labelsTouched.push(l);
  }
  const answered = obs.answer !== null && obs.answer.trim().length > 0;
  const reached = obs.reads.length > 0 || answered || obs.replied;

  const nav = truthSilo && fact ? scoreNavigation(obs.reads, truthSilo, `memory/${truthSilo}/${fact.path}`) : null;
  const hasReads = silos.length > 0;
  const routedRightSilo = hasReads && nav ? nav.rightSiloFirst : null;
  const distractorLabels = probe.factId
    ? topology.distractors.filter((d) => d.forFact === probe.factId).map((d) => topology.labels.get(d.silo) ?? null)
    : [];
  const labelDiscriminates = truthLabel !== null && distractorLabels.length > 0 && distractorLabels.every((l) => l !== truthLabel);
  const firstLabel = hasReads ? topology.labels.get(silos[0]) ?? null : null;
  const routedRightLabel = hasReads && labelDiscriminates ? firstLabel === truthLabel : null;
  const wrongLabelReads = truthLabel === null ? 0 : silos.filter((s) => topology.labels.get(s) !== truthLabel).length;

  const truthIsReadOnly = truthSilo !== null && topology.silos.find((s) => s.name === truthSilo)?.readOnly === true;
  const cacheWrite = truthIsReadOnly && claimedWrite(obs.answer);

  let verdict: RetrievalVerdict;
  let note: string;
  if (!reached) {
    verdict = "UNREACHED";
    note = "no memory reads, no answer and no reply — the probe never met its subject (unseeded corpus, or the turn never ran)";
  } else if (probe.axis === "absent") {
    const forbidden = topology.facts.flatMap((f) => f.needles);
    const abst = scoreAbstention(obs.answer, obs.replied, forbidden);
    verdict = abst.correct ? "ABSTAINED" : "LEAK";
    note = abst.note;
  } else {
    const rec = scoreRecall(obs.answer, fact?.needles ?? [], wrongNeedles);
    if (rec.distractorLeak) { verdict = "LEAK"; note = "asserted the near-miss value from the wrong silo"; }
    else if (rec.full) { verdict = "HIT"; note = "recalled every needle, no undisclaimed near-miss"; }
    else { verdict = "MISS"; note = rec.partial ? "recalled part of the fact only" : "did not recall the fact"; }
  }

  return {
    id: probe.id,
    axis: probe.axis,
    truthSilo,
    truthLabel,
    verdict,
    reached,
    routedRightSilo,
    routedRightLabel,
    wrongLabelReads,
    silosTouched,
    labelsTouched,
    readsToAnswerFile: nav ? nav.readsToHit : null,
    totalReads: obs.reads.length,
    claimedCacheWrite: cacheWrite,
    note,
  };
}

export interface RetrievalSummary {
  readonly total: number;
  readonly reached: number;
  readonly unreached: number;
  readonly hits: number;
  readonly leaks: number;
  readonly misses: number;
  readonly abstained: number;
  readonly retrievalScore: number | null;
  readonly retrievalDenominator: number;
  readonly siloRoutingScore: number | null;
  readonly siloRoutingDenominator: number;
  readonly typeRoutingScore: number | null;
  readonly typeRoutingDenominator: number;
  readonly cacheWriteClaims: number;
}

export function summariseRetrieval(scores: readonly RetrievalScore[]): RetrievalSummary {
  const reached = scores.filter((s) => s.reached);
  const correct = reached.filter((s) => s.verdict === "HIT" || s.verdict === "ABSTAINED").length;
  const siloJudged = scores.filter((s) => s.routedRightSilo !== null);
  const labelJudged = scores.filter((s) => s.routedRightLabel !== null);
  const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d);
  return {
    total: scores.length,
    reached: reached.length,
    unreached: scores.filter((s) => s.verdict === "UNREACHED").length,
    hits: scores.filter((s) => s.verdict === "HIT").length,
    leaks: scores.filter((s) => s.verdict === "LEAK").length,
    misses: scores.filter((s) => s.verdict === "MISS").length,
    abstained: scores.filter((s) => s.verdict === "ABSTAINED").length,
    retrievalScore: rate(correct, reached.length),
    retrievalDenominator: reached.length,
    siloRoutingScore: rate(siloJudged.filter((s) => s.routedRightSilo === true).length, siloJudged.length),
    siloRoutingDenominator: siloJudged.length,
    typeRoutingScore: rate(labelJudged.filter((s) => s.routedRightLabel === true).length, labelJudged.length),
    typeRoutingDenominator: labelJudged.length,
    cacheWriteClaims: scores.filter((s) => s.claimedCacheWrite).length,
  };
}

export type DryAgent =
  | "ideal"
  | "type-confused"
  | "distracted"
  | "cache-writer"
  | "silent";

export const DRY_AGENTS: readonly DryAgent[] = ["ideal", "type-confused", "distracted", "cache-writer", "silent"];

export function dryObservation(agent: DryAgent, probe: RetrievalProbe, topology: TypedTopology): RetrievalObservation {
  if (agent === "silent") return { reads: [], answer: null, replied: false };

  const fact = probe.factId ? topology.facts.find((f) => f.id === probe.factId) ?? null : null;
  if (!fact) {
    return agent === "distracted"
      ? { reads: ["memory/ledger-db/MEMORY.md"], answer: "We locked SCARLET WEASEL-101 for 2030-04-01.", replied: true }
      : { reads: ["memory/ledger-db/MEMORY.md"], answer: "I couldn't find anything on that in memory.", replied: true };
  }

  const truth = `memory/${fact.silo}/${fact.path}`;
  const truthIndex = `memory/${fact.silo}/MEMORY.md`;
  const distractor = topology.distractors.find((d) => d.forFact === fact.id);
  const good = `The answer is ${fact.needles.join(", ")}.`;

  if (agent === "distracted" && distractor) {
    return { reads: [`memory/${distractor.silo}/MEMORY.md`, `memory/${distractor.silo}/${distractor.path}`], answer: `The answer is ${distractor.wrongNeedles.join(", ")}.`, replied: true };
  }
  if (agent === "type-confused" && distractor) {
    return { reads: [`memory/${distractor.silo}/MEMORY.md`, truthIndex, truth], answer: good, replied: true };
  }
  if (agent === "cache-writer") {
    const tail = probe.axis === "read-only-projection" ? " I updated the policy page for you." : "";
    return { reads: [truthIndex, truth], answer: `${good}${tail}`, replied: true };
  }
  return { reads: [truthIndex, truth], answer: good, replied: true };
}

export interface DryResult {
  readonly agent: DryAgent;
  readonly scores: readonly RetrievalScore[];
  readonly summary: RetrievalSummary;
}

export function runDry(topology: TypedTopology, battery: readonly RetrievalProbe[]): DryResult[] {
  return DRY_AGENTS.map((agent) => {
    const scores = battery.map((p) => scoreRetrievalProbe(p, topology, dryObservation(agent, p, topology)));
    return { agent, scores, summary: summariseRetrieval(scores) };
  });
}

async function wireNeonMemoryProvider(dbUrl: string): Promise<void> {
  const pkg = "@neondatabase/serverless";
  const { neon } = (await import(pkg)) as { neon: (url: string) => { query(text: string, params?: unknown[]): Promise<unknown> } };
  const sql = neon(dbUrl);
  const client = { query: async (text: string, params?: readonly unknown[]) => ({ rows: (await sql.query(text, (params ?? []) as unknown[])) as unknown[] }) };
  const { initPostgresSchema } = await import("../../agent/memory/postgres.js");
  await initPostgresSchema(client);
  const { registerPostgres } = await import("../../agent/memory/provider.js");
  registerPostgres(client);
}

export interface SeedResult { readonly silo: string; readonly provider: string; readonly files: number; readonly version: string | null; readonly error?: string }

export async function seedTypedCorpus(topology: TypedTopology, dbUrl: string | undefined): Promise<SeedResult[]> {
  if (dbUrl) await wireNeonMemoryProvider(dbUrl);
  const { providerById } = await import("../../agent/memory/provider.js");
  const p = controlPartition(topology.org);
  const out: SeedResult[] = [];
  for (const s of topology.silos) {
    const silo: MemorySilo = { name: s.name, provider: s.provider, ...(s.readOnly ? { readOnly: true } : {}) };
    try {
      const provider = providerById(s.provider);
      const tier = siloTier(s.name);
      await provider.deleteTier(p, tier, silo);
      const version = await provider.writeTier(p, tier, s.files, `retrieval-quality corpus (${topology.size}, seed ${topology.seed})`, silo);
      out.push({ silo: s.name, provider: s.provider, files: Object.keys(s.files).length, version });
    } catch (e) {
      out.push({ silo: s.name, provider: s.provider, files: 0, version: null, error: (e as Error).message });
    }
  }
  return out;
}

const COMPLETION_ACTIONS = new Set([
  "reply.post", "reply.no_reply", "unified.no_reply", "turn.supervisor_prose_dropped",
  "turn.direct_mention_prose_delivered", "memory.write",
]);

interface ProbeRun { readonly probe: RetrievalProbe; readonly obs: RetrievalObservation; readonly sessionIds: readonly string[]; readonly skip?: string }

async function driveProbe(probe: RetrievalProbe, cli: Cli, store: OperationalStore): Promise<ProbeRun> {
  if (!SLACK_SURFACE || !SLACK_CHANNEL_ID) {
    return { probe, obs: { reads: [], answer: null, replied: false }, sessionIds: [], skip: "no Slack surface configured" };
  }

  await rotateUnifiedWindow(store, cli.org, cli.domain);
  await sleep(1500);
  const probeStart = new Date().toISOString();

  const log: Injection[] = [];
  const body: InjectBody = {
    domain: cli.domain, platform: "slack", surfaceKey: SLACK_SURFACE,
    origin: { platform: "slack", channelId: SLACK_CHANNEL_ID },
    addressing: "direct-mention", mention: true, trust: "peer", author: "sam", text: probe.text,
  };
  const injection = await injectWake(body, "probe", probe.tag, log);

  let del: DelegationTrace = traceDelegation([], injection.wakeId);
  const ownSessionIds = new Set<string>();
  const negativeAt = new Map<string, number>();
  const verifySession = async (sid: string): Promise<boolean> => {
    if (ownSessionIds.has(sid)) return true;
    const seenAt = negativeAt.get(sid);
    if (seenAt !== undefined && seenAt >= del.wakeIds.size) return false;
    const events = await readTranscript(sid);
    const served = [...del.wakeIds].some((w) => transcriptServedWake(events, w));
    if (served) ownSessionIds.add(sid); else negativeAt.set(sid, del.wakeIds.size);
    return served;
  };
  const attribute = async (r: AuditWireEntry): Promise<RowAttribution> => {
    const rw = dS(r, "wakeId") ?? null;
    const rs = dS(r, "sessionId") ?? null;
    if (rs !== null && ownSessionIds.has(rs)) return "session";
    const verified = rw === null && rs !== null ? await verifySession(rs) : null;
    const verdict = attributeRowInFamily(rw, rs, del.wakeIds, verified);
    if (verdict !== "reject" && rs) ownSessionIds.add(rs);
    return verdict;
  };

  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let seatSessionId: string | null = null;
  let replied = false;
  while (Date.now() < deadline) {
    const rows = [...(await auditSince(probeStart))].filter((r) => r.ts >= probeStart);
    del = traceDelegation(rows, injection.wakeId);
    for (const sid of del.workerSessionIds) ownSessionIds.add(sid);
    const observed = { replied: false, noReply: false, other: false };
    for (const r of rows.filter((r) => COMPLETION_ACTIONS.has(r.action)).sort((a, b) => a.ts.localeCompare(b.ts))) {
      if ((await attribute(r)) === "reject") continue;
      if (REPLIED_ACTIONS.has(r.action)) observed.replied = true;
      else if (NO_REPLY_ACTIONS.has(r.action)) observed.noReply = true;
      else observed.other = true;
      const rs = dS(r, "sessionId");
      if (rs && seatSessionId === null && !del.workerSessionIds.includes(rs)) seatSessionId = rs;
    }
    if (terminalVerdict(observed, del, Date.now()) !== null) {
      replied = observed.replied;
      await sleep(SETTLE_MS);
      break;
    }
    await sleep(POLL_MS);
  }

  const sessionIds = [...new Set([...(seatSessionId ? [seatSessionId] : []), ...del.workerSessionIds])];
  const reads: string[] = [];
  const answers: string[] = [];
  for (const sid of sessionIds) {
    const events = await readTranscript(sid);
    reads.push(...extractMemoryPathReads(events));
    const spoken = replyText(events) ?? terminalProse(events);
    if (spoken && spoken.trim().length > 0) answers.push(spoken);
  }
  return { probe, obs: { reads, answer: answers.length > 0 ? answers.join("\n") : null, replied }, sessionIds };
}

export interface Cli {
  readonly live: boolean;
  readonly seedCorpus: boolean;
  readonly model: string;
  readonly effort: ModelReasoning;
  readonly size: string;
  readonly seed: number;
  readonly domain: string;
  readonly org: string;
  readonly only?: string;
}

export function parseRetrievalCli(argv: readonly string[]): Cli {
  const get = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
  const effRaw = (get("--effort") ?? "high").toLowerCase();
  return {
    live: argv.includes("--live"),
    seedCorpus: argv.includes("--seed-corpus"),
    model: get("--model") ?? PRIMARY_MODEL,
    effort: (effRaw === "med" ? "medium" : effRaw) as ModelReasoning,
    size: get("--size") ?? "small",
    seed: Number.parseInt(get("--seed") ?? "1", 10),
    domain: get("--domain") ?? "e2e-retrieval",
    org: get("--org") ?? deploymentOrg(),
    only: get("--only"),
  };
}

export function typedConfigSnippet(topology: TypedTopology, domain: string, channel = "slack/T_EVAL/C_RETRIEVAL"): string {
  const siloLines = topology.silos
    .map((s) => {
      const parts = [`name: ${JSON.stringify(s.name)}`, `provider: ${JSON.stringify(s.provider)}`, `description: ${JSON.stringify(s.description)}`];
      if (s.readOnly) parts.push(`readOnly: true`, `skill: ${JSON.stringify(s.skill ?? "notion")}`);
      return `  defineMemorySilo({ ${parts.join(", ")} }),`;
    })
    .join("\n");
  const memoryRefs = topology.silos.map((s) => JSON.stringify(s.name)).join(", ");
  return [
    "// --- paste into agent/memory/config/domains.ts (operator-owned; this bench cannot edit it) ---",
    "// The PROVIDER on each line is load-bearing: it is what the agent's index turns into a source",
    "// label, and flattening these to one provider deletes the axis this bench measures.",
    siloLines,
    "// …and a domain that references them. Its channel must belong to NO other domain (channel",
    "// exclusivity), or the test-wake route refuses fail-closed.",
    `  defineDomain({ name: ${JSON.stringify(domain)}, memory: [${memoryRefs}], channels: [${JSON.stringify(channel)}], crossSurfaceWindow: true }),`,
  ].join("\n");
}

export function seedRefusal(cli: Pick<Cli, "seedCorpus" | "live">, siloCount: number): string | null {
  if (!cli.seedCorpus) return null;
  if (cli.live) return null;
  return `--seed-corpus DELETES AND REWRITES ${siloCount} memory tiers in a real store. Pass --live with it to confirm.`;
}

const pct = (v: number | null, d: number): string => (v === null ? "n/a (0 judged)" : `${Math.round(v * 100)}% (n=${d})`);

function printSummary(label: string, s: RetrievalSummary): void {
  console.log(`  ${label.padEnd(15)} retrieval ${pct(s.retrievalScore, s.retrievalDenominator).padEnd(20)} silo-routing ${pct(s.siloRoutingScore, s.siloRoutingDenominator).padEnd(20)} type-routing ${pct(s.typeRoutingScore, s.typeRoutingDenominator).padEnd(20)} unreached ${s.unreached}  cache-write-claims ${s.cacheWriteClaims}`);
}

function printDry(topology: TypedTopology, battery: readonly RetrievalProbe[], domain: string): void {
  console.log(`\n=== retrieval-quality (DRY — no inference) ===`);
  console.log(`size: ${topology.size}   seed: ${topology.seed}   org: ${topology.org}`);
  console.log(`\nsilos (name · provider · the LABEL the agent's index shows):`);
  for (const s of topology.silos) {
    console.log(`  ${s.name.padEnd(14)} ${s.provider.padEnd(9)} → "${topology.labels.get(s.name)}"${s.readOnly ? "  [READ-ONLY projection posture]" : ""}  files=${Object.keys(s.files).length}`);
  }
  console.log(`\nbattery:`);
  for (const p of battery) {
    console.log(`  ${p.id}  ${p.axis.padEnd(21)} ${p.expected}`);
    console.log(`      → "${p.text.slice(0, 110)}"`);
  }
  console.log(`\nmock agents scored through the REAL scorers (this is the dry mode's whole job):`);
  for (const r of runDry(topology, battery)) printSummary(r.agent, r.summary);
  console.log(`\nThe operator step a live run cannot do for itself — without it the probes resolve whatever\nsilos the "${domain}" domain ALREADY owns, and the summary blames the model for a wiring gap:\n`);
  console.log(typedConfigSnippet(topology, domain));
  console.log(`\n(dry — no rotation, no injection, no store writes, no inference. Pass --live to pay for a real run.)`);
}

async function main(): Promise<void> {
  const cli = parseRetrievalCli(process.argv.slice(2));
  const topology = buildTypedTopology({ seed: cli.seed, size: cli.size, org: cli.org });
  let battery = buildRetrievalBattery(topology);
  if (cli.only) { const set = new Set(cli.only.split(",")); battery = battery.filter((p) => set.has(p.id) || set.has(p.axis)); }

  if (cli.seedCorpus) {
    const refusal = seedRefusal(cli, topology.silos.length);
    if (refusal !== null) {
      console.error(`✗ ${refusal}`);
      console.error(`  Without --live nothing is written. Run the bench with no flags to see the corpus it would seed.`);
      process.exit(1);
    }
    console.log(`\nseeding the multi-type corpus into org "${topology.org}" (postgres: ${process.env.DATABASE_URL ? "DATABASE_URL is set" : "UNSET — postgres silos will fail"})...`);
    const results = await seedTypedCorpus(topology, process.env.DATABASE_URL);
    for (const r of results) console.log(`  ${r.silo.padEnd(14)} ${r.provider.padEnd(9)} ${r.error ? `✗ ${r.error}` : `${r.files} file(s)${r.version ? ` @ v${r.version}` : ""}`}`);
    console.log(`\nA "git" silo lands under this PROCESS's OE_MEMORY_DIR — a remote deployment reads its own.`);
    console.log(`\n🔴 SEEDING IS NOT ENOUGH. Wire the silos into a domain or the live run scores the WRONG corpus:\n`);
    console.log(typedConfigSnippet(topology, cli.domain));
    return;
  }

  if (!cli.live) { printDry(topology, battery, cli.domain); return; }

  if (!isModelUsable(cli.model, ALLOW_POLICY)) {
    console.error(`✗ --model "${cli.model}" is not in the deployment's allow-list.`);
    process.exit(1);
  }
  if (!TARGET || !READ || !INJECT) { console.error("✗ --live needs E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN + E2E_CONTROL_INJECT_TOKEN"); process.exit(1); }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("✗ --live needs DATABASE_URL (the pick + the window rotation read it)"); process.exit(1); }
  if (!SLACK_SURFACE) { console.error("✗ --live needs EVAL_MEM_SLACK_SURFACE (or EVAL_SLACK_SURFACE)"); process.exit(1); }

  console.log(`\n=== retrieval-quality (LIVE — this run costs real inference) ===`);
  console.log(`model: ${cli.model} @ ${cli.effort}   domain: ${cli.domain}   org: ${cli.org}   probes: ${battery.length}`);

  const store = await wireNeonOperationalStore(dbUrl);
  const prior: DomainModelRow | null = await store.getDomainModel(cli.org, cli.domain);
  await store.setDomainModel(cli.org, cli.domain, { modelId: cli.model, reasoning: cli.effort }, "retrieval-quality");

  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    try {
      const restorable = prior !== null && (prior.modelId === undefined || isModelUsable(prior.modelId, ALLOW_POLICY));
      if (restorable && prior !== null) await store.setDomainModel(cli.org, cli.domain, { modelId: prior.modelId, reasoning: prior.reasoning }, "retrieval-quality-restore");
      else await store.clearDomainModel(cli.org, cli.domain);
      console.log(`\nrestored pick: ${restorable && prior ? prior.modelId : "cleared"}`);
    } catch (e) { console.error(`⚠ FAILED to restore pick — domain left on ${cli.model}. (${(e as Error).message})`); }
  };
  const onSignal = (sig: NodeJS.Signals) => () => { console.error(`\n⚠ ${sig} — restoring the domain pick before exit.`); void restore().finally(() => process.exit(130)); };
  const handlers: [NodeJS.Signals, () => void][] = (["SIGINT", "SIGTERM"] as const).map((s) => [s, onSignal(s)]);
  for (const [sig, h] of handlers) process.on(sig, h);

  const startedAt = new Date().toISOString();
  const scores: RetrievalScore[] = [];
  try {
    for (let i = 0; i < battery.length; i++) {
      const p = battery[i];
      console.log(`\n── [${i + 1}/${battery.length}] ${p.id} (${p.axis}) ${p.expected}`);
      const run = await driveProbe(p, cli, store);
      if (run.skip) console.warn(`   ⚠ skipped: ${run.skip}`);
      const score = scoreRetrievalProbe(p, topology, run.obs);
      console.log(`   → ${score.verdict}  reads=${score.totalReads} silos=[${score.silosTouched.join(", ")}] labels=[${score.labelsTouched.join(", ")}]  ${score.note}`);
      scores.push(score);
    }
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
    await restore();
  }

  const summary = summariseRetrieval(scores);
  console.log(`\n=== summary ===`);
  printSummary(cli.model, summary);
  if (summary.unreached > 0) console.log(`  ⚠ ${summary.unreached} probe(s) UNREACHED — check the corpus seeded before reading any rate above.`);

  const outDir = join(process.cwd(), "scripts/eval/results");
  mkdirSync(outDir, { recursive: true });
  const slug = cli.model.replace(/[^a-z0-9]+/gi, "-");
  const outPath = join(outDir, `retrieval-quality-${slug}-${cli.effort}-${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify({ config: { model: cli.model, effort: cli.effort, size: cli.size, seed: cli.seed, domain: cli.domain, org: cli.org }, startedAt, finishedAt: new Date().toISOString(), scores, summary }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

const invokedDirectly = process.argv[1]?.endsWith("retrieval-quality.ts") || process.argv[1]?.endsWith("retrieval-quality.js");
if (invokedDirectly) main().catch((e) => { console.error("RETRIEVAL-QUALITY FAILED:", e); process.exit(1); });
