import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { registerSettings } from "../packages/core/agent/settings/settings.js";
import { scanSensitive, luhnValid, mrzCheckDigit, type SensitiveFinding } from "../packages/core/agent/access/sensitive-data.js";

registerSettings({});

const ROOT = new URL("..", import.meta.url).pathname;

const EXCLUDED = new Set([
  "packages/core/agent/access/sensitive-data.ts",
  "packages/core/agent/access/outbound-filter.ts",
  "packages/core/scripts/outbound-filter-test.ts",
  "scripts/sensitive-data-measure.ts",
]);

const MAX_FALSE_POSITIVE_RATE = 0.0001;
const MAX_LOOK_ALIKE_RATE = 0.01;
const MAX_IN_FORMAT_MISS_RATE = 0;

let seed = 2665;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const digits = (n: number): string => Array.from({ length: n }, () => String(int(0, 9))).join("");
const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;

function withLuhn(body: string): string {
  for (let d = 0; d <= 9; d++) if (luhnValid(body + d)) return body + d;
  throw new Error("unreachable");
}

const BRANDS: ReadonlyArray<[string, number]> = [
  ["4", 16],
  ["51", 16],
  ["55", 16],
  ["2223", 16],
  ["34", 15],
  ["37", 15],
  ["6011", 16],
  ["65", 16],
  ["3530", 16],
  ["36", 14],
  ["62", 16],
];

function card(): string {
  const [prefix, len] = pick(BRANDS);
  return withLuhn(prefix + digits(len - prefix.length - 1));
}

function grouped(c: string, sep: string): string {
  if (c.length === 15) return `${c.slice(0, 4)}${sep}${c.slice(4, 10)}${sep}${c.slice(10)}`;
  if (c.length === 14) return `${c.slice(0, 4)}${sep}${c.slice(4, 10)}${sep}${c.slice(10)}`;
  return c.match(/.{1,4}/g)!.join(sep);
}

function ssn(): string {
  let area = int(1, 899);
  if (area === 666) area = 665;
  return `${String(area).padStart(3, "0")}-${String(int(1, 99)).padStart(2, "0")}-${String(int(1, 9999)).padStart(4, "0")}`;
}

function nino(): string {
  const first = "ABCEGHJKLMNOPRSTWXYZ";
  const second = "ABCEGHJKLMNPRSTWXYZ";
  let pre = pick([...first]) + pick([...second]);
  while (["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"].includes(pre)) pre = pick([...first]) + pick([...second]);
  return `${pre} ${digits(2)} ${digits(2)} ${digits(2)} ${pick(["A", "B", "C", "D"])}`;
}

function mrzLine2(): string {
  const doc = `${pick(["L", "C", "P"])}${digits(8)}`;
  const birth = `${String(int(50, 99))}${String(int(1, 12)).padStart(2, "0")}${String(int(1, 28)).padStart(2, "0")}`;
  const expiry = `${String(int(26, 35))}${String(int(1, 12)).padStart(2, "0")}${String(int(1, 28)).padStart(2, "0")}`;
  const line = `${doc}${mrzCheckDigit(doc)}GBR${birth}${mrzCheckDigit(birth)}${pick(["M", "F"])}${expiry}${mrzCheckDigit(expiry)}<<<<<<<<<<<<<<0`;
  return `${line}${mrzCheckDigit(line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43))}`;
}

function iban(): string {
  const bban = `${pick(["WEST", "NWBK", "BARC", "LOYD"])}${digits(14)}`;
  const moved = `${bban}GB00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  const check = String(98 - rem).padStart(2, "0");
  return `GB${check}${bban}`.match(/.{1,4}/g)!.join(" ");
}

function walk(dir: string, keep: (p: string) => boolean, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
}

function linesOf(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (EXCLUDED.has(relative(ROOT, f))) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) if (line.trim().length > 0) out.push(line);
  }
  return out;
}

const docFiles: string[] = [];
walk(join(ROOT, "docs"), (p) => p.endsWith(".md"), docFiles);
const codeFiles: string[] = [];
for (const pkg of ["packages/core/agent", "packages/adapters/agent", "agent"]) walk(join(ROOT, pkg), (p) => p.endsWith(".ts") && !p.includes("/generated/") && !p.endsWith(".generated.ts"), codeFiles);

let gitLines: string[] = [];
try {
  gitLines = execFileSync("git", ["log", "--format=%s%n%b"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\n")
    .filter((l) => l.trim().length > 0);
} catch {
  gitLines = [];
}

const lookAlikes: string[] = [];
for (let i = 0; i < 20_000; i++) {
  lookAlikes.push(
    pick([
      () => `see the thread at ts ${int(1600000000, 1799999999)}.${digits(6)}`,
      () => `slack ts ${int(1600000000, 1799999999)}${digits(6)}`,
      () => `discord message ${int(1, 1)}${digits(18)}`,
      () => `order #${digits(int(10, 16))} shipped`,
      () => `tracking 1Z${digits(16)}`,
      () => `FedEx tracking ${digits(12)}`,
      () => `call me on +44 ${digits(2)} ${digits(4)} ${digits(4)}`,
      () => `phone ${digits(3)}-${digits(3)}-${digits(4)}`,
      () => `uuid ${digits(8)}-${digits(4)}-4${digits(3)}-a${digits(3)}-${digits(12)}`,
      () => `commit ${Array.from({ length: 40 }, () => "0123456789abcdef"[int(0, 15)]).join("")}`,
      () => `ip 10.${int(0, 255)}.${int(0, 255)}.${int(0, 255)}`,
      () => `version ${int(0, 9)}.${int(0, 99)}.${int(0, 999)}`,
      () => `that costs $${int(1, 99999)}.${digits(2)}`,
      () => `deadline 20${int(20, 40)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
      () => `invoice INV-${digits(8)} for ${int(1, 999)} units`,
      () => `aws account ${digits(12)} in us-east-1`,
      () => `ISBN 978-${digits(1)}-${digits(3)}-${digits(5)}-${digits(1)}`,
      () => `the run took ${digits(int(4, 9))} ms over ${digits(int(3, 6))} rows`,
      () => `${digits(4)} ${digits(4)} ${digits(4)} ${digits(4)} rows exported`,
      () => `ref ${digits(16)}`,
    ])(),
  );
}

const inFormat: Array<{ text: string; category: SensitiveFinding["category"] }> = [];
for (let i = 0; i < 2_000; i++) {
  const c = card();
  inFormat.push({
    text: pick([
      `my card is ${c}`,
      `card: ${grouped(c, " ")}`,
      `pay with ${grouped(c, "-")} please`,
      `${grouped(c, " ")} exp 04/29`,
      `card ${grouped(c, ".")}`,
      `card ${grouped(c, " ").replace(" ", "-")}`,
      `card ${c.split("").join(" ")}`,
    ]),
    category: "card-number",
  });
}
for (let i = 0; i < 500; i++) inFormat.push({ text: pick([`SSN ${ssn()}`, `her ssn is ${ssn()}.`]), category: "government-id" });
for (let i = 0; i < 500; i++) inFormat.push({ text: `NI number ${nino()}`, category: "government-id" });
for (let i = 0; i < 500; i++) inFormat.push({ text: pick([`passport number: ${digits(9)}`, `Passport No. ${pick(["C", "L", ""])}${digits(8)}`, `passport ${digits(9)} expires 2031`]), category: "government-id" });
for (let i = 0; i < 300; i++) inFormat.push({ text: `P<GBRSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n${mrzLine2()}`, category: "government-id" });
for (let i = 0; i < 300; i++) inFormat.push({ text: `IBAN ${iban()}`, category: "personal-finance" });
for (let i = 0; i < 300; i++) inFormat.push({ text: pick([`he was diagnosed with ${pick(["type 2 diabetes", "asthma", "epilepsy", "bipolar disorder", "crohn's disease"])}`, `she is taking ${pick(["insulin", "metformin", "sertraline"])} daily`]), category: "health" });

const outOfFormat: Array<{ text: string; form: string }> = [];
for (let i = 0; i < 500; i++) {
  const c = card();
  outOfFormat.push(pick([
    { text: `card ${c.match(/.{1,3}/g)!.join(" ")}`, form: "card in groups of three" },
    { text: `card ${c.split("").join("-")}`, form: "card with a dash between every digit" },
    { text: `card ${c.slice(0, 8)} / ${c.slice(8)}`, form: "card split in two halves" },
  ]));
}
for (let i = 0; i < 200; i++) outOfFormat.push({ text: `travel document ${digits(9)}`, form: "passport number without the word passport" });
for (let i = 0; i < 200; i++) outOfFormat.push({ text: `my number is ${ssn().replace(/-/g, "")}`, form: "unlabelled SSN without dashes" });

interface Hit {
  readonly source: string;
  readonly types: string;
  readonly line: string;
}

function measureNegatives(name: string, lines: readonly string[], hits: Hit[]): { lines: number; hits: number } {
  let n = 0;
  for (const line of lines) {
    const f = scanSensitive(line);
    if (f.length > 0) {
      n++;
      hits.push({ source: name, types: [...new Set(f.map((x) => x.type))].join(","), line: line.trim().slice(0, 160) });
    }
  }
  return { lines: lines.length, hits: n };
}

const hits: Hit[] = [];
const neg = [
  ["docs", linesOf(docFiles)],
  ["code", linesOf(codeFiles)],
  ["git log", gitLines],
  ["look-alikes", lookAlikes],
] as const;
let negLines = 0;
let negHits = 0;
let lookAlikeRate = 0;
console.log("NEGATIVE CORPUS (any finding is a false positive)");
for (const [name, lines] of neg) {
  const r = measureNegatives(name, lines, hits);
  console.log(`  ${name.padEnd(12)} ${String(r.lines).padStart(7)} lines  ${String(r.hits).padStart(4)} matched  (${((r.hits / Math.max(1, r.lines)) * 100).toFixed(4)}%)`);
  if (name === "look-alikes") {
    lookAlikeRate = r.hits / Math.max(1, r.lines);
    continue;
  }
  negLines += r.lines;
  negHits += r.hits;
}
const fpRate = negLines === 0 ? 0 : negHits / negLines;
console.log(`  REAL TEXT    ${String(negLines).padStart(7)} lines  ${String(negHits).padStart(4)} matched  → false-positive rate ${(fpRate * 100).toFixed(4)}%`);
for (const h of hits.filter((x) => x.source !== "look-alikes")) console.log(`    [${h.source}] ${h.types}: ${h.line}`);
const lookAlikeTypes = new Map<string, number>();
for (const h of hits.filter((x) => x.source === "look-alikes")) lookAlikeTypes.set(h.types, (lookAlikeTypes.get(h.types) ?? 0) + 1);
console.log(`  look-alike matches by detector: ${[...lookAlikeTypes].map(([t, n]) => `${t}=${n}`).join(", ") || "(none)"}`);

let inMiss = 0;
const missByCategory = new Map<string, [number, number]>();
for (const p of inFormat) {
  const found = scanSensitive(p.text).some((f) => f.category === p.category);
  const [m, t] = missByCategory.get(p.category) ?? [0, 0];
  missByCategory.set(p.category, [m + (found ? 0 : 1), t + 1]);
  if (!found) inMiss++;
}
const inMissRate = inMiss / inFormat.length;
console.log("\nIN-FORMAT POSITIVES (generated; any non-finding is a miss)");
for (const [cat, [m, t]] of missByCategory) console.log(`  ${cat.padEnd(18)} ${String(t).padStart(5)} values  ${String(m).padStart(4)} missed`);
console.log(`  ${"TOTAL".padEnd(18)} ${String(inFormat.length).padStart(5)} values  ${String(inMiss).padStart(4)} missed  → miss rate ${(inMissRate * 100).toFixed(2)}%`);

const outByForm = new Map<string, [number, number]>();
for (const p of outOfFormat) {
  const found = scanSensitive(p.text).length > 0;
  const [m, t] = outByForm.get(p.form) ?? [0, 0];
  outByForm.set(p.form, [m + (found ? 0 : 1), t + 1]);
}
console.log("\nOUT-OF-FORMAT POSITIVES (forms no shipped detector claims — the honest bound)");
for (const [form, [m, t]] of outByForm) console.log(`  ${form.padEnd(44)} ${String(t).padStart(4)} values  ${String(m).padStart(4)} missed  (${((m / t) * 100).toFixed(1)}%)`);

const red: string[] = [];
if (fpRate > MAX_FALSE_POSITIVE_RATE) red.push(`real-text false-positive rate ${(fpRate * 100).toFixed(4)}% is over the ${(MAX_FALSE_POSITIVE_RATE * 100).toFixed(4)}% bound`);
if (lookAlikeRate > MAX_LOOK_ALIKE_RATE) red.push(`look-alike match rate ${(lookAlikeRate * 100).toFixed(4)}% is over the ${(MAX_LOOK_ALIKE_RATE * 100).toFixed(2)}% bound`);
if (inMissRate > MAX_IN_FORMAT_MISS_RATE) red.push(`in-format miss rate ${(inMissRate * 100).toFixed(2)}% is over the ${MAX_IN_FORMAT_MISS_RATE * 100}% bound`);
if (red.length > 0) {
  for (const r of red) console.error(`✗ ${r}`);
  process.exit(1);
}
console.log(`\n✓ sensitive-data measurement within bounds`);
