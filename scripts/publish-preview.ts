import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { npmCommand } from "./npm-command.js";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";

export type Severity = "block" | "review";

export interface NeverShipRule {
  readonly id: string;
  readonly why: string;
  readonly severity: Severity;
  readonly path?: RegExp;
  readonly content?: RegExp;
}

const PLACEHOLDER =
  /<[^>]*>|\.\.\.|…|\bxxx+\b|\byour[-_]|\bexample\.(?:com|net|org)\b|\bplaceholder\b|\breplace[-_ ]?me|\bREPLACE\b|\$\{|\bpaste\b/i;

export const NEVER_SHIP_RULES: readonly NeverShipRule[] = [
  {
    id: "env-file",
    why: "an env file carries values — only .env.example (names, no values) may ever be tracked",
    severity: "block",
    path: /(^|\/)\.env(\.|$)(?!example)/,
  },
  {
    id: "harness-tree",
    why: ".claude/ is agent harness config — roles, skills and run telemetry, never a consumer's business",
    severity: "block",
    path: /(^|\/)\.claude\//,
  },
  {
    id: "run-telemetry",
    why: "a run note or run report is one agent run's scratch narrative",
    severity: "block",
    path: /(^|\/)\.oe-run-(note|report)\.md$/,
  },
  {
    id: "local-state",
    why: "a local store holds other people's conversations, memory or audit rows",
    severity: "block",
    path: /(^|\/)(\.open-everywhere-memory|\.eve|\.output|\.workflow-data)\/|\.sqlite3?(\.|$)/,
  },
  {
    id: "private-key",
    why: "a PEM private key block",
    severity: "block",
    content: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  },
  {
    id: "slack-token",
    why: "a Slack bot, user or app token",
    severity: "block",
    content: /\bxox[baprse]-[0-9A-Za-z]{8,}-[0-9A-Za-z-]{8,}/,
  },
  {
    id: "github-token",
    why: "a GitHub personal-access or installation token",
    severity: "block",
    content: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  },
  {
    id: "linear-key",
    why: "a Linear API key",
    severity: "block",
    content: /\blin_api_[A-Za-z0-9]{30,}\b/,
  },
  {
    id: "model-key",
    why: "an OpenAI/Anthropic-shaped model key",
    severity: "block",
    content: /\bsk-(?:ant-)?[A-Za-z0-9_-]{30,}\b/,
  },
  {
    id: "jwt",
    why: "a signed JWT — an OIDC token or a session credential",
    severity: "block",
    content: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    id: "env-value",
    why: "an env var assigned a real-looking value — env files carry names and guidance only",
    severity: "block",
    content:
      /^\s*(?:export\s+)?(?:(?:OE|SLACK|DISCORD|TEAMS|LINEAR|NOTION|GITHUB|AI_GATEWAY|VERCEL|NEON|DATABASE|POSTGRES|ANTHROPIC|OPENAI)[A-Z0-9_]*|[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*["']?[A-Za-z0-9+/_:.@-]{20,}/,
  },
  {
    id: "live-surface-id",
    why: "a Slack-shaped workspace/channel/user id — judge each one: live operator id, or doc example?",
    severity: "review",
    content: /\b[TCDUGW][0-9][A-Z0-9]{6,9}\b/,
  },
];

export interface NeverShipHit {
  readonly rule: NeverShipRule;
  readonly file: string;
  readonly line: number;
  readonly redacted: string;
}

export function redact(value: string): string {
  return `${value.slice(0, 3)}…(${value.length})`;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|gz|tgz|pdf|mp4|wasm)$/i;

export function scanNeverShip(files: readonly string[], read: (file: string) => string): NeverShipHit[] {
  const hits: NeverShipHit[] = [];
  for (const file of files) {
    for (const rule of NEVER_SHIP_RULES) {
      if (rule.path?.test(file)) hits.push({ rule, file, line: 0, redacted: redact(file) });
    }
    if (BINARY.test(file)) continue;
    const contentRules = NEVER_SHIP_RULES.filter((r) => r.content);
    if (contentRules.length === 0) continue;
    let body: string;
    try {
      body = read(file);
    } catch {
      continue;
    }
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      for (const rule of contentRules) {
        const m = rule.content!.exec(text);
        if (!m) continue;
        if (rule.id === "env-value" && PLACEHOLDER.test(text)) continue;
        hits.push({ rule, file, line: i + 1, redacted: redact(m[0]) });
      }
    }
  }
  return hits;
}

export function exitCode(blocking: number, reviewable: number, strict: boolean): 0 | 1 {
  return blocking > 0 || (strict && reviewable > 0) ? 1 : 0;
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function main(): void {
  const argv = process.argv;
  const flag = (name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const strict = argv.includes("--strict");
  const only = flag("--only");
  const targets = only ? ALL_PUBLISHABLE_PACKAGES.filter((p) => p === only) : [...ALL_PUBLISHABLE_PACKAGES];
  if (targets.length === 0) {
    console.error(`✗ no publishable package matched --only ${only}`);
    process.exit(1);
  }

  const out = flag("--out") ?? mkdtempSync(join(tmpdir(), "oe-publish-preview-"));
  mkdirSync(out, { recursive: true });
  console.log(`Publish preview — ${targets.length} package(s)\nScratch directory: ${out}\n`);

  let blocking = 0;
  let reviewable = 0;
  const sizes: string[] = [];

  for (const pkgDir of targets) {
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, any>;
    const name = manifest.name as string;
    const packed = execFileSync(...npmCommand(["pack", "--workspace", name, "--pack-destination", out, "--loglevel", "error", "--ignore-scripts"]), {
      encoding: "utf8",
    });
    const tgz = join(out, packed.trim().split("\n").pop()!);
    const unpacked = join(out, "unpacked", name.replace(/[@/]/g, "_"));
    mkdirSync(unpacked, { recursive: true });
    execFileSync("tar", ["-xzf", relative(out, tgz), "-C", relative(out, unpacked), "--strip-components", "1"], { cwd: out });

    const files = walk(unpacked);
    const bytes = new Map(files.map((f) => [f, statSync(join(unpacked, f)).size]));
    const total = [...bytes.values()].reduce((a, b) => a + b, 0);
    const tarballBytes = statSync(tgz).size;
    sizes.push(`${name}@${manifest.version} — ${kb(tarballBytes)} packed, ${kb(total)} unpacked, ${files.length} files`);

    console.log(`── ${name}@${manifest.version}`);
    console.log(`   tarball ${kb(tarballBytes)} · unpacked ${kb(total)} · ${files.length} file(s)`);

    const byDir = new Map<string, { n: number; bytes: number }>();
    for (const [f, b] of bytes) {
      const top = f.includes("/") ? `${f.split("/")[0]}/` : "(root)";
      const row = byDir.get(top) ?? { n: 0, bytes: 0 };
      byDir.set(top, { n: row.n + 1, bytes: row.bytes + b });
    }
    for (const [dir, row] of [...byDir].sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.log(`     ${dir.padEnd(24)} ${String(row.n).padStart(5)} file(s)  ${kb(row.bytes).padStart(12)}`);
    }
    const largest = [...bytes].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`   largest:`);
    for (const [f, b] of largest) console.log(`     ${kb(b).padStart(12)}  ${f}`);

    const listingPath = join(out, `${name.replace(/[@/]/g, "_")}.files.txt`);
    writeFileSync(listingPath, `${[...bytes].map(([f, b]) => `${String(b).padStart(9)}  ${f}`).join("\n")}\n`);
    console.log(`   full listing: ${listingPath}`);

    const hits = scanNeverShip(files, (f) => readFileSync(join(unpacked, f), "utf8"));
    const blocks = hits.filter((h) => h.rule.severity === "block");
    const reviews = hits.filter((h) => h.rule.severity === "review");
    blocking += blocks.length;
    reviewable += reviews.length;
    if (hits.length === 0) console.log(`   never-ship scan: clean\n`);
    else {
      console.log(`   never-ship scan: ${blocks.length} blocking, ${reviews.length} to review`);
      for (const group of [blocks, reviews]) {
        const byRule = new Map<string, NeverShipHit[]>();
        for (const h of group) byRule.set(h.rule.id, [...(byRule.get(h.rule.id) ?? []), h]);
        for (const [id, list] of byRule) {
          const rule = list[0]!.rule;
          console.log(`     [${rule.severity}] ${id} — ${rule.why} (${list.length})`);
          const byValue = new Map<string, NeverShipHit[]>();
          for (const h of list) byValue.set(h.redacted, [...(byValue.get(h.redacted) ?? []), h]);
          for (const [value, at] of [...byValue].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
            const where = at.slice(0, 3).map((h) => `${h.file}${h.line > 0 ? `:${h.line}` : ""}`).join(", ");
            console.log(`       ${value.padEnd(16)} ×${String(at.length).padStart(4)}  ${where}${at.length > 3 ? ", …" : ""}`);
          }
          if (byValue.size > 15) console.log(`       … ${byValue.size - 15} more distinct value(s)`);
        }
      }
      console.log("");
    }
  }

  console.log("── Tarball sizes");
  for (const s of sizes) console.log(`   ${s}`);
  console.log(
    `\nnever-ship: ${blocking} blocking, ${reviewable} to review.` +
      `\nUnpacked trees are under ${join(out, "unpacked")} — read any file this report names before publishing.`,
  );
  if (exitCode(blocking, reviewable, strict) === 1) {
    console.error(`\n✗ publish preview: ${blocking + (strict ? reviewable : 0)} finding(s) must be cleared first.`);
    process.exit(1);
  }
  console.log(`\n✓ publish preview: nothing blocking. The REVIEW rows above still need a human.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
