import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER_SHIP_RULES, exitCode, redact, scanNeverShip } from "./publish-preview.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW = join(root, "scripts", "publish-preview.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

function ids(file: string, body: string): string[] {
  return scanNeverShip([file], () => body).map((h) => h.rule.id);
}

const FAKE = {
  slack: `xox${"b"}-${"1".repeat(12)}-${"9".repeat(12)}-${"abcdefghijklmnopqrst"}`,
  github: `gh${"p"}_${"A1b2C3d4E5f6G7h8I9j0".repeat(2)}`,
  linear: `lin${"_"}api_${"k".repeat(40)}`,
  model: `sk${"-"}${"z".repeat(40)}`,
  jwt: `ey${"J"}${"abcdefghijk"}.${"lmnopqrstuv"}.${"wxyz01234567"}`,
  pem: `-----BEGIN ${"RSA"} PRIVATE KEY-----`,
};

ok(NEVER_SHIP_RULES.every((r) => Boolean(r.path) !== Boolean(r.content)), "every rule sets exactly one matcher");
ok(new Set(NEVER_SHIP_RULES.map((r) => r.id)).size === NEVER_SHIP_RULES.length, "rule ids are unique");
ok(
  NEVER_SHIP_RULES.filter((r) => r.severity === "block").length >= 8,
  "the blocking rules are still present — a table trimmed to review-only blocks nothing",
);

ok(ids("a.ts", `const t = "${FAKE.slack}";`).includes("slack-token"), "a Slack token is caught");
ok(ids("a.ts", `const t = "${FAKE.github}";`).includes("github-token"), "a GitHub token is caught");
ok(ids("a.ts", `const t = "${FAKE.linear}";`).includes("linear-key"), "a Linear key is caught");
ok(ids("a.ts", `const t = "${FAKE.model}";`).includes("model-key"), "a model key is caught");
ok(ids("a.ts", `const t = "${FAKE.jwt}";`).includes("jwt"), "a signed JWT is caught");
ok(ids("a.pem", FAKE.pem).includes("private-key"), "a PEM private-key block is caught");
ok(
  scanNeverShip(["a.ts"], () => `const t = "${FAKE.slack}";`).every((h) => h.rule.severity === "block"),
  "a credential is BLOCKING, never merely reviewable",
);

ok(ids("a.ts", `// a bot token starts with xoxb-`).length === 0, "the bare prefix xoxb- is NOT a finding");
ok(ids("a.ts", `if (token.startsWith("xoxb-")) return "bot";`).length === 0, "a prefix CHECK is not a finding");
ok(ids("a.ts", `const k = "sk-";`).length === 0, "a bare sk- prefix is not a finding");

ok(
  ids(".env.local", `SLACK_BOT_TOKEN=${FAKE.slack}`).includes("env-value"),
  "a dotenv assignment carrying a value is caught",
);
ok(
  ids("doc.md", `DATABASE_URL=postgresql://oe:s3cretpassword@ep-cool-water-12345.eu-west-2.aws.neon.tech/oe`).includes(
    "env-value",
  ),
  "a filled-in connection string naming a real host is caught",
);
ok(
  ids("doc.md", `DATABASE_URL=postgresql://oe:s3cretpassword@db.example.net:5432/oe`).length === 0,
  "an assignment naming an RFC 2606 example host is treated as documentation",
);
ok(
  ids("doc.md", `DATABASE_URL=postgres://oe:hunter2hunter2hunter2@db.example-corp.com:5432/oe`).includes("env-value"),
  "a private host that merely CONTAINS 'example' is not an RFC 2606 host",
);
ok(
  ids("doc.md", `OE_SLACK_SIGNING_SECRET=8f14e45fceea167a5a36dedd4bea2543  # example from the Slack app page`).includes(
    "env-value",
  ),
  "a trailing '# example …' comment does NOT excuse a real value",
);
ok(
  ids("doc.md", `OE_TOKEN=abcdefghijklmnopqrstuvwxyz # TODO rotate`).includes("env-value"),
  "a '# TODO rotate' comment does NOT excuse a real value — it is evidence the value is live",
);
ok(
  ids(".env.local", `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENGbPxRfiCYzzzzzzzzzzz`).includes("env-value"),
  "a non-vendor name containing SECRET is caught",
);
ok(
  ids(".env.local", `STRIPE_SECRET=rk_live_51H8xQ2eZvKYlo2C0abcdefghijklmnop`).includes("env-value"),
  "…and so is one for a service we do not integrate at all",
);
ok(
  ids("a.ts", `const OE_DIRECTORY_PROVIDER_ENV = "OE_DIRECTORY_PROVIDER";`).length === 0,
  "a TypeScript const that DECLARES an env NAME is not an env VALUE",
);
ok(
  ids("a.ts", `  const OE_AWS_SSO_CLIENT_ID_ENV = "OE_AWS_SSO_CLIENT_ID";`).length === 0,
  "…including an indented one",
);
ok(ids("doc.md", `OE_MEMORY_PROVIDER=sqlite`).length === 0, "a short non-secret value is not a finding");
ok(
  ids("doc.md", `DATABASE_URL=<your-connection-string-goes-here>`).length === 0,
  "a placeholder assignment is not a finding",
);
ok(
  ids("doc.md", `SLACK_SIGNING_SECRET=REPLACE_ME_WITH_THE_REAL_SIGNING_SECRET`).length === 0,
  "a REPLACE_ME assignment is not a finding",
);
ok(
  ids("doc.md", `# example: SLACK_BOT_TOKEN=${FAKE.slack}`).includes("slack-token"),
  "a placeholder marker does NOT excuse a credential on the same line",
);

ok(ids(".env.local", "").includes("env-file"), "a .env file is caught by its path");
ok(ids("config/.env.production", "").includes("env-file"), "…at any depth");
ok(ids(".env.example", "").length === 0, "NEGATIVE CONTROL: .env.example is the one tracked env file");
ok(ids(".claude/agents/builder.md", "").includes("harness-tree"), ".claude/ is caught");
ok(ids(".oe-run-note.md", "").includes("run-telemetry"), "a run note is caught");
ok(ids("data/agent.sqlite3", "").includes("local-state"), "a local store is caught");
ok(ids("agent/memory/store.ts", "").length === 0, "NEGATIVE CONTROL: an ordinary source path is clean");

const idHits = scanNeverShip(["a.ts"], () => `// e.g. "slack/T0EXAMPLE/U0EXOWNER"`);
ok(idHits.some((h) => h.rule.id === "live-surface-id"), "a Slack-shaped id is reported");
ok(
  idHits.filter((h) => h.rule.id === "live-surface-id").every((h) => h.rule.severity === "review"),
  "…as REVIEW, because nothing can tell a live id from a doc example by shape",
);
ok(ids("a.ts", `const kind = "TEAM";`).length === 0, "NEGATIVE CONTROL: a plain capitalised word is not an id");

ok(exitCode(1, 0, false) === 1, "🔴 a BLOCKING hit exits 1, with or without --strict");
ok(exitCode(1, 0, true) === 1, "…and under --strict too");
ok(exitCode(0, 1, false) === 0, "a REVIEW row alone exits 0 — it is a row for a human, not a refusal");
ok(exitCode(0, 1, true) === 1, "…and --strict promotes it to a refusal");
ok(exitCode(0, 0, true) === 0, "a clean tree exits 0 even under --strict");

ok(redact("T0EXAMPLE") === "T0E…(9)", "redact keeps three characters and the length");
const leak = scanNeverShip(["a.ts"], () => `const t = "${FAKE.slack}";`);
ok(leak.length > 0, "the leak fixture produced a hit to inspect");
ok(
  leak.every((h) => !h.redacted.includes(FAKE.slack) && h.redacted.length < 20),
  "🔴 no hit carries the matched value — the report cannot leak what it found",
);

let readCalls = 0;
scanNeverShip(["logo.png", "a.ts"], () => {
  readCalls++;
  return "";
});
ok(readCalls === 1, "a binary file is never content-scanned");

function preview(outDir: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, PREVIEW, "--out", outDir, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const scratch: string[] = [];
function outDir(): string {
  const d = mkdtempSync(join(tmpdir(), "oe-preview-suite-"));
  scratch.push(d);
  return d;
}

try {
  const cleanOut = outDir();
  const clean = preview(cleanOut, "--only", "packages/create", "--strict");
  ok(clean.code === 0, `a clean package previews green even under --strict (got ${clean.code})`);
  ok(/@open-everywhere\/create@/.test(clean.out), "the report names the package and its version");
  ok(/tarball .* KiB/.test(clean.out), "the report carries the tarball size — the number the PR quotes");
  ok(/never-ship scan: clean/.test(clean.out), "the clean package reports a clean scan");
  ok(
    existsSync(join(cleanOut, "_open-everywhere_create.files.txt")),
    "the COMPLETE per-file listing is written to disk, not only summarised on stdout",
  );

  const REVIEWED = "packages/providers/linear";
  const strict = preview(outDir(), "--only", REVIEWED, "--strict");
  const lenient = preview(outDir(), "--only", REVIEWED);
  const counts = /never-ship: (\d+) blocking, (\d+) to review/.exec(lenient.out);
  ok(counts !== null, "the report states its own never-ship counts");
  const [blocking, reviewable] = [Number(counts![1]), Number(counts![2])];
  ok(
    reviewable > 0,
    `${REVIEWED} is the promotion fixture and no longer carries a REVIEW row — point this at a bundle that does`,
  );
  ok(blocking === 0, `${REVIEWED} must have nothing BLOCKING, or the lenient control below proves nothing`);
  ok(strict.code === 1, `--strict promotes a REVIEW row to a failure (got ${strict.code})`);
  ok(lenient.code === 0, `…and the same tree is green without it (got ${lenient.code})`);
  ok(/\[review\] live-surface-id/.test(lenient.out), "the review row names the rule and is printed either way");

  const bogus = preview(outDir(), "--only", "packages/nope");
  ok(bogus.code === 1, "an unknown --only target refuses rather than previewing nothing");
} finally {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
}

console.log(`✓ publish-preview: ${passed} assertion(s) passed`);
