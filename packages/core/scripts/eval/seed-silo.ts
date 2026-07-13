import { controlPartition } from "../../agent/memory/partition.js";
import { siloTier } from "../../agent/memory/store.js";
import type { MemoryFiles } from "../../agent/memory/store.js";
import { mulberry32, pick } from "./memory-eval-harness.js";

export type SiloShape = "flat" | "repo-tree" | "nested";
export type DescQuality = "clear" | "vague";

export interface PlantedFact {
  readonly id: string;
  readonly silo: string;
  readonly path: string;
  readonly depth: number;
  readonly question: string;
  readonly needles: readonly string[];
  readonly topic: string;
}

export interface Distractor {
  readonly forFact: string;
  readonly silo: string;
  readonly path: string;
  readonly wrongNeedles: readonly string[];
}

export interface SiloBuild {
  readonly name: string;
  readonly provider: string;
  readonly description: string;
  readonly descriptionQuality: DescQuality;
  readonly shape: SiloShape;
  readonly readOnly: boolean;
  readonly skill?: string;
  readonly files: MemoryFiles;
}

export interface Topology {
  readonly seed: number;
  readonly size: string;
  readonly org: string;
  readonly silos: readonly SiloBuild[];
  readonly facts: readonly PlantedFact[];
  readonly distractors: readonly Distractor[];
  readonly absentProbe: { readonly question: string; readonly topic: string };
}

const ADJ = ["SCARLET", "COBALT", "AMBER", "JADE", "CRIMSON", "AZURE", "IVORY", "ONYX", "SABLE", "TOPAZ"];
const ANIMAL = ["WEASEL", "HERON", "LYNX", "OTTER", "FALCON", "MARTEN", "BADGER", "STOAT", "RAVEN", "IBEX"];
const FILLER_TOPICS = [
  "the weekly deploy cadence", "on-call rotation notes", "a Grafana dashboard link", "lunch-and-learn ideas",
  "the sprint retro actions", "a flaky-test triage list", "office wifi credentials rotation", "a hackathon pitch",
  "the quarterly OKR draft", "meeting-room booking etiquette", "a coffee-machine maintenance log", "team offsite logistics",
];
const codename = (rng: () => number): string => `${pick(rng, ADJ)} ${pick(rng, ANIMAL)}-${Math.floor(rng() * 900 + 100)}`;
const shipDate = (rng: () => number): string => `20${29 + Math.floor(rng() * 5)}-${String(Math.floor(rng() * 12) + 1).padStart(2, "0")}-${String(Math.floor(rng() * 27) + 1).padStart(2, "0")}`;
const ref = (rng: () => number): string => `R-${Math.floor(rng() * 9000 + 1000)}`;

const depthOf = (path: string): number => path.split("/").length - 1;

const SECTIONS = "\n## Standing instructions\n(none yet)\n\n## People / ownership\n(none yet)\n\n## Decisions\n";

function clearIndex(name: string, children: { dir: string; purpose: string }[]): string {
  const lines = [`# Memory silo — "${name}"`, "", "Start here. This index maps the subtree; descend to the named child for detail.", ""];
  if (children.length > 0) {
    lines.push("## Sections");
    for (const c of children) lines.push(`- **${c.dir}/** — ${c.purpose}. Read \`${c.dir}/MEMORY.md\`.`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function vagueIndex(name: string, children: { dir: string }[]): string {
  const kids = children.map((c) => c.dir).join(", ");
  return `# ${name}\n\nAssorted notes. Some things are filed away in here somewhere${kids ? ` (${kids})` : ""}. Have a look around.\n`;
}

function subIndex(dir: string, children: string[], quality: DescQuality): string {
  if (quality === "clear") {
    const lines = [`# ${dir}`, "", "Contents of this node:"];
    for (const c of children) lines.push(`- \`${c}/\` — see its \`MEMORY.md\`.`);
    return lines.join("\n") + "\n";
  }
  return `# ${dir}\n\n${children.join(", ")}\n`;
}

function decisionsFile(topic: string, bullet: string): string {
  return `# ${topic} — decisions\n${SECTIONS}${bullet}\n`;
}

function fillerNote(rng: () => number, n: number): string {
  const t = pick(rng, FILLER_TOPICS);
  return `# note-${n}\n\n- 20${29 + Math.floor(rng() * 5)}-01-${String((n % 27) + 1).padStart(2, "0")}: quick note about ${t}. Nothing load-bearing here.\n`;
}

interface SiloSpec {
  readonly name: string;
  readonly provider: string;
  readonly description: string;
  readonly descriptionQuality: DescQuality;
  readonly shape: SiloShape;
  readonly readOnly?: boolean;
  readonly skill?: string;
  readonly tree?: readonly { readonly dir: string; readonly purpose: string; readonly children: readonly string[] }[];
}

export const DEFAULT_SILOS: readonly SiloSpec[] = [
  {
    name: "payments-brain",
    provider: "postgres",
    description: "payments-domain decisions — refunds, chargebacks, settlement, KYC",
    descriptionQuality: "clear",
    shape: "nested",
    tree: [
      { dir: "refunds", purpose: "refund + chargeback policy and decisions", children: ["chargebacks", "disputes", "sla"] },
      { dir: "settlement", purpose: "settlement timing + reconciliation", children: ["timing", "recon", "fees"] },
      { dir: "kyc", purpose: "identity + onboarding rules", children: ["onboarding", "risk", "reviews"] },
    ],
  },
  {
    name: "platform-notes",
    provider: "postgres",
    description: "platform engineering — services, deploys, infra decisions",
    descriptionQuality: "clear",
    shape: "repo-tree",
    tree: [
      { dir: "services", purpose: "per-service ownership + runbooks", children: ["gateway", "ledger", "webhooks"] },
      { dir: "infra", purpose: "infra + deploy topology", children: ["deploy", "networking", "observability"] },
    ],
  },
  {
    name: "misc",
    provider: "postgres",
    description: "misc",
    descriptionQuality: "vague",
    shape: "flat",
  },
  {
    name: "handbook-cache",
    provider: "postgres",
    description: "company handbook — HR, expenses, security policy (read-only cache)",
    descriptionQuality: "clear",
    shape: "nested",
    readOnly: true,
    skill: "notion",
    tree: [
      { dir: "hr", purpose: "leave, benefits, reviews", children: ["leave", "benefits", "reviews"] },
      { dir: "security", purpose: "access, incident, data policy", children: ["access", "incident", "data"] },
    ],
  },
];

const SIZE_TARGETS: Record<string, number> = { tiny: 12, small: 100, medium: 500, large: 2000 };

export interface BuildOpts {
  readonly seed?: number;
  readonly size?: string;
  readonly org?: string;
  readonly silos?: readonly SiloSpec[];
}

export function buildTopology(opts: BuildOpts = {}): Topology {
  const seed = opts.seed ?? 1;
  const size = opts.size ?? "small";
  const org = opts.org ?? "default";
  const specs = opts.silos ?? DEFAULT_SILOS;
  const target = SIZE_TARGETS[size] ?? SIZE_TARGETS.small;
  const rng = mulberry32(seed);

  const facts: PlantedFact[] = [];
  const distractors: Distractor[] = [];
  const builds: SiloBuild[] = [];

  const filesBySilo = new Map<string, MemoryFiles>();
  const leafDirsBySilo = new Map<string, string[]>();

  for (const spec of specs) {
    const files: MemoryFiles = {};
    const leafDirs: string[] = [];
    const topChildren: { dir: string; purpose: string }[] = [];

    if (spec.shape === "flat" || !spec.tree) {
      leafDirs.push("");
    } else {
      for (const sec of spec.tree) {
        topChildren.push({ dir: sec.dir, purpose: sec.purpose });
        files[`${sec.dir}/MEMORY.md`] = subIndex(sec.dir, sec.children as string[], spec.descriptionQuality);
        for (const grand of sec.children) {
          files[`${sec.dir}/${grand}/MEMORY.md`] = subIndex(`${sec.dir}/${grand}`, [], spec.descriptionQuality);
          leafDirs.push(`${sec.dir}/${grand}`);
        }
        leafDirs.push(sec.dir);
      }
    }

    files["MEMORY.md"] =
      spec.descriptionQuality === "clear"
        ? clearIndex(spec.name, topChildren)
        : vagueIndex(spec.name, topChildren.map((c) => ({ dir: c.dir })));

    filesBySilo.set(spec.name, files);
    leafDirsBySilo.set(spec.name, leafDirs);
    builds.push({
      name: spec.name,
      provider: spec.provider,
      description: spec.description,
      descriptionQuality: spec.descriptionQuality,
      shape: spec.shape,
      readOnly: spec.readOnly === true,
      ...(spec.skill !== undefined ? { skill: spec.skill } : {}),
      files,
    });
  }

  const writable = builds.filter((b) => !b.readOnly).map((b) => b.name);
  const plantPlan: { silo: string; path: string; topic: string; distractorSilo: string }[] = [
    { silo: "payments-brain", path: "refunds/chargebacks/decisions.md", topic: "chargeback", distractorSilo: "platform-notes" },
    { silo: "payments-brain", path: "settlement/decisions.md", topic: "settlement", distractorSilo: "misc" },
    { silo: "platform-notes", path: "services/gateway/decisions.md", topic: "gateway rollout", distractorSilo: "payments-brain" },
    { silo: "misc", path: "decisions.md", topic: "office move", distractorSilo: "platform-notes" },
    { silo: "payments-brain", path: "kyc/onboarding/decisions.md", topic: "KYC onboarding", distractorSilo: "misc" },
  ].filter((p) => writable.includes(p.silo));

  plantPlan.forEach((p, i) => {
    const code = codename(rng);
    const date = shipDate(rng);
    const rf = ref(rng);
    const bullet = `- ${date}: locked codename ${code} for the ${p.topic} flow, ship ${date}, ref ${rf}. Holding other releases that day.`;
    const files = filesBySilo.get(p.silo)!;
    files[p.path] = decisionsFile(p.topic, bullet);
    facts.push({
      id: `F${i + 1}`,
      silo: p.silo,
      path: p.path,
      depth: depthOf(p.path),
      question: `what codename, ship date and ref did we lock for the ${p.topic} flow? reply with all three.`,
      needles: [code, date, rf],
      topic: p.topic,
    });

    const dCode = codename(rng);
    const dDate = shipDate(rng);
    const dRef = ref(rng);
    const dSilo = builds.find((b) => b.name === p.distractorSilo);
    if (dSilo && !dSilo.readOnly) {
      const dFiles = filesBySilo.get(p.distractorSilo)!;
      const dLeafs = leafDirsBySilo.get(p.distractorSilo)!;
      const dDir = dLeafs.length > 0 ? pick(rng, dLeafs) : "";
      const dPath = dDir ? `${dDir}/${p.topic.replace(/\s+/g, "-")}-notes.md` : `${p.topic.replace(/\s+/g, "-")}-notes.md`;
      dFiles[dPath] = `# ${p.topic} (stray note)\n\n- someone mentioned "${p.topic}" here once: an OLD/WRONG value ${dCode}, ${dDate}, ${dRef}. This is NOT the locked decision — the real one lives in the ${p.silo} silo.\n`;
      distractors.push({ forFact: `F${i + 1}`, silo: p.distractorSilo, path: dPath, wrongNeedles: [dCode, dRef] });
    }
  });

  const cache = builds.find((b) => b.readOnly);
  if (cache) {
    const cfiles = filesBySilo.get(cache.name)!;
    cfiles["security/data/decisions.md"] = `# data policy\n${SECTIONS}- 2029-03-01: data retention is 90 days for logs, ref R-DATA-90. Update via the ${cache.skill ?? "handbook"} tools — this cache is read-only.\n`;
  }

  const structuralCount = builds.reduce((n, b) => n + Object.keys(filesBySilo.get(b.name)!).length, 0);
  let toAdd = Math.max(0, target - structuralCount);
  let fillerN = 0;
  const padTargets = builds.filter((b) => !b.readOnly);
  while (toAdd > 0 && padTargets.length > 0) {
    for (const b of padTargets) {
      if (toAdd <= 0) break;
      const files = filesBySilo.get(b.name)!;
      const leafs = leafDirsBySilo.get(b.name)!;
      const dir = leafs.length > 0 ? pick(rng, leafs) : "";
      const path = dir ? `${dir}/note-${fillerN}.md` : `note-${fillerN}.md`;
      if (!files[path]) {
        files[path] = fillerNote(rng, fillerN);
        toAdd--;
      }
      fillerN++;
      if (fillerN > target * 5 + 100) toAdd = 0;
    }
  }

  const absentProbe = {
    question: "what codename and ship date did we lock for the loyalty-points programme? reply with both.",
    topic: "loyalty-points programme",
  };

  return { seed, size, org, silos: builds, facts, distractors, absentProbe };
}

async function wireNeonMemoryProvider(dbUrl: string): Promise<import("../../agent/memory/provider.js").MemoryProvider> {
  const pkg = "@neondatabase/serverless";
  const { neon } = (await import(pkg)) as { neon: (url: string) => { query(text: string, params?: unknown[]): Promise<unknown> } };
  const sql = neon(dbUrl);
  const client = { query: async (text: string, params?: readonly unknown[]) => ({ rows: (await sql.query(text, (params ?? []) as unknown[])) as unknown[] }) };
  const { initPostgresSchema } = await import("../../agent/memory/postgres.js");
  await initPostgresSchema(client);
  const { registerPostgres } = await import("../../agent/memory/provider.js");
  return registerPostgres(client);
}

export async function seedLive(topology: Topology, dbUrl: string): Promise<{ silo: string; files: number; version: string | null }[]> {
  const provider = await wireNeonMemoryProvider(dbUrl);
  const p = controlPartition(topology.org);
  const results: { silo: string; files: number; version: string | null }[] = [];
  for (const s of topology.silos) {
    const tier = siloTier(s.name);
    await provider.deleteTier(p, tier, { name: s.name, provider: s.provider });
    const version = await provider.writeTier(p, tier, s.files, `seed-silo topology (${topology.size}, seed ${topology.seed})`, { name: s.name, provider: s.provider });
    results.push({ silo: s.name, files: Object.keys(s.files).length, version });
  }
  return results;
}

export function configSnippet(topology: Topology, domain = "e2e-memory", channel = "slack/T_EVAL/C_MEMORY"): string {
  const siloLines = topology.silos
    .map((s) => {
      const parts = [`name: ${JSON.stringify(s.name)}`, `provider: "postgres"`, `description: ${JSON.stringify(s.description)}`];
      if (s.readOnly) parts.push(`readOnly: true`, `skill: ${JSON.stringify(s.skill ?? "notion")}`);
      return `  defineMemorySilo({ ${parts.join(", ")} }),`;
    })
    .join("\n");
  const memoryRefs = topology.silos.map((s) => JSON.stringify(s.name)).join(", ");
  return [
    "// --- paste into agent/memory/domains.ts (operator-owned; the seeder cannot edit it) ---",
    "// silos:",
    siloLines,
    "// domain (channel must be a crossSurfaceWindow-enabled surface — see the e2e-unified domain):",
    `  defineDomain({ name: ${JSON.stringify(domain)}, channels: [${JSON.stringify(channel)}], memory: [${memoryRefs}], crossSurfaceWindow: true }),`,
  ].join("\n");
}

interface SeedCli {
  readonly plan: boolean;
  readonly seed: number;
  readonly size: string;
  readonly org: string;
  readonly domain: string;
}
function parseSeedCli(argv: readonly string[]): SeedCli {
  const get = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
  return {
    plan: argv.includes("--plan") || argv.includes("--dry-run"),
    seed: Number.parseInt(get("--seed") ?? "1", 10),
    size: get("--size") ?? "small",
    org: get("--org") ?? process.env.OE_ORG ?? "default",
    domain: get("--domain") ?? "e2e-memory",
  };
}

function printPlan(topology: Topology, cli: SeedCli): void {
  console.log(`\n=== seed-silo topology (PLAN) ===`);
  console.log(`seed: ${topology.seed}   size: ${topology.size} (target ~${SIZE_TARGETS[topology.size] ?? SIZE_TARGETS.small} files)   org: ${topology.org}`);
  console.log(`\nsilos:`);
  for (const s of topology.silos) {
    console.log(`  - ${s.name.padEnd(16)} ${s.provider}  shape=${s.shape.padEnd(9)} desc=${s.descriptionQuality.padEnd(5)}${s.readOnly ? " [READ-ONLY cache]" : ""}  files=${Object.keys(s.files).length}`);
    console.log(`      description: ${JSON.stringify(s.description)}`);
  }
  console.log(`\nplanted facts (silo · depth · path):`);
  for (const f of topology.facts) {
    console.log(`  ${f.id}  ${f.silo.padEnd(16)} d${f.depth}  ${f.path}`);
    console.log(`      Q: ${f.question}`);
    console.log(`      needles: ${f.needles.join(" | ")}`);
  }
  console.log(`\nnear-miss distractors (in the WRONG silo):`);
  for (const d of topology.distractors) console.log(`  ${d.forFact} → ${d.silo}/${d.path}  wrong: ${d.wrongNeedles.join(" | ")}`);
  console.log(`\nabsent probe (answer in NO silo → expect abstention):\n  Q: ${topology.absentProbe.question}`);
  console.log(`\n${configSnippet(topology, cli.domain)}`);
  console.log(`\n(plan-only — no DB writes.)`);
}

async function main(): Promise<void> {
  const cli = parseSeedCli(process.argv.slice(2));
  const topology = buildTopology({ seed: cli.seed, size: cli.size, org: cli.org });

  if (cli.plan) { printPlan(topology, cli); return; }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("✗ DATABASE_URL required (live Neon) to seed. Use --plan to smoke-test the topology offline."); process.exit(1); }

  console.log(`\nseeding ${topology.silos.length} silo(s) into org "${topology.org}" (size ${topology.size}, seed ${topology.seed})...`);
  const results = await seedLive(topology, dbUrl);
  for (const r of results) console.log(`  ${r.silo.padEnd(16)} ${r.files} file(s)${r.version ? ` @ v${r.version}` : ""}`);
  console.log(`\n✓ seeded. Ensure domains.ts wires the e2e-memory domain (seed-silo.ts --plan prints the snippet).`);
}

const invokedDirectly = process.argv[1]?.endsWith("seed-silo.ts") || process.argv[1]?.endsWith("seed-silo.js");
if (invokedDirectly) main().catch((e) => { console.error("SEED-SILO FAILED:", e); process.exit(1); });
