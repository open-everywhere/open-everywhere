import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuditWireEntry } from "./audit-read.js";

export const QA_FIXTURE_DIR = "qa-app";

export const QA_SHOT_FILE = "oe-qa-shot.png";

export const QA_PORT = 8000;

const QA_SEED = "oe-qa-fixture-v1";

export const QA_HEADING_WORDS: readonly string[] = [
  "HERON", "MAPLE", "COBALT", "LANTERN", "WALRUS", "QUARTZ", "PEPPER", "GLACIER",
  "TULIP", "BISON", "CANYON", "VELVET", "ORBIT", "PELICAN", "SAFFRON", "THUNDER",
  "BADGER", "CORAL", "FALCON", "JUNIPER", "MEADOW", "NUTMEG", "OTTER", "PRAIRIE",
  "RAVEN", "SPRUCE", "TIMBER", "VIOLET", "WILLOW", "ZEPHYR", "ANCHOR", "BEACON",
];

export const QA_RUN_TOKEN_RE = /^[a-z0-9-]{4,40}$/;

export function freshQaRunToken(): string {
  return `qa-${createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 10)}`;
}

export function qaHeading(run: string): string {
  const digest = createHash("sha256").update(`${QA_SEED}:${run}`).digest();
  return `${QA_HEADING_WORDS[digest[0]! % QA_HEADING_WORDS.length]} ${QA_HEADING_WORDS[digest[1]! % QA_HEADING_WORDS.length]}`;
}

export function qaPageUrl(run: string): string {
  return `http://localhost:${QA_PORT}/?run=${run}`;
}

export function qaBrief(repo: string, run: string): string {
  return (
    `In a sandbox worker, run this QA loop on the repository ${repo}, end to end: ` +
    `(1) use checkout_repo to clone ${repo}. ` +
    `(2) Start its dev server from the ${QA_FIXTURE_DIR}/ directory of the checkout, in the background, WITH BOTH OUTPUT STREAMS REDIRECTED ` +
    "(a background job that still holds stdout/stderr hangs the bash call — agent/instructions.md), e.g. " +
    `\`cd <checkout dir>/${QA_FIXTURE_DIR} && PORT=${QA_PORT} npm run dev > server.log 2>&1 &\`. ` +
    "The app has ZERO dependencies, so do NOT run npm install. Wait until server.log says it is listening. " +
    `(3) Use browser_navigate to open ${qaPageUrl(run)} — keep the run parameter exactly as written. ` +
    `(4) Use browser_screenshot to SAVE the page as \`${QA_SHOT_FILE}\` in your CURRENT WORKING DIRECTORY, using that RELATIVE path ` +
    "(NOT /tmp, NOT an absolute path: describe_image and post_file can only read files inside your workspace). " +
    `(5) Use describe_image with { kind: "path", ref: "${QA_SHOT_FILE}" } to read the big page heading from the screenshot IMAGE. ` +
    "CRITICAL: get the heading ONLY from describe_image on the screenshot — do NOT read it from the page text or DOM " +
    "(browser_get, browser_snapshot, browser_evaluate), from curl, or from the source code. " +
    `(6) Use post_file to post the screenshot to this thread: source { path: "${QA_SHOT_FILE}" }, filename "${QA_SHOT_FILE}". ` +
    "Then reply with the exact heading describe_image read from the screenshot."
  );
}

const SERVER_JS = `// Scratch QA app — the Open Everywhere F-QA-REPO e2e fixture (OPE-2404).
// GENERATED from packages/core/scripts/e2e/qa-repo.ts in the Open Everywhere repository. Do not edit
// it here: change the generator and copy the new bytes across, or the e2e leg reports drift.
// Zero dependencies — \`npm run dev\` is \`node server.js\`, and no install step exists.
const { createServer } = require("node:http");
const { createHash } = require("node:crypto");

const SEED = ${JSON.stringify(QA_SEED)};
const WORDS = ${JSON.stringify(QA_HEADING_WORDS)};
const TOKEN = ${QA_RUN_TOKEN_RE.toString()};

function heading(run) {
  const digest = createHash("sha256").update(SEED + ":" + run).digest();
  return WORDS[digest[0] % WORDS.length] + " " + WORDS[digest[1] % WORDS.length];
}

function page(body) {
  return "<!doctype html><html><head><meta charset=\\"utf-8\\"><title>Scratch QA</title>" +
    "<style>body{font-family:sans-serif;margin:48px}h1{font-size:64px;letter-spacing:2px}</style>" +
    "</head><body>" + body + "</body></html>";
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const run = url.searchParams.get("run") || "";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    TOKEN.test(run)
      ? page("<p>Scratch QA</p><h1>" + heading(run) + "</h1>")
      : page("<p>Scratch QA</p><h2>No run token. Open /?run=&lt;token&gt;.</h2>"),
  );
});

const port = Number(process.env.PORT || ${QA_PORT});
server.listen(port, () => {
  console.log("e2e-scratch qa-app listening on http://localhost:" + server.address().port);
});
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "e2e-scratch-qa-app",
    private: true,
    description: "The Open Everywhere F-QA-REPO e2e fixture: a zero-dependency dev server.",
    scripts: { dev: "node server.js" },
  },
  null,
  2,
)}\n`;

const README_MD = `# Scratch QA app

The Open Everywhere \`F-QA-REPO\` e2e fixture (OPE-2404). A zero-dependency dev server: there is no
install step.

    npm run dev            # the same as: node server.js
    PORT=8000 npm run dev  # 8000 is the default

Open \`http://localhost:8000/?run=<token>\`. The page heading is two words derived from the run token.

The files are GENERATED by \`packages/core/scripts/e2e/qa-repo.ts\` in the Open Everywhere repository.
Do not edit them here.
`;

export const QA_FIXTURE_FILES: Readonly<Record<string, string>> = {
  [`${QA_FIXTURE_DIR}/package.json`]: PACKAGE_JSON,
  [`${QA_FIXTURE_DIR}/server.js`]: SERVER_JS,
  [`${QA_FIXTURE_DIR}/README.md`]: README_MD,
};

export function qaFixtureDrift(remote: Readonly<Record<string, string | undefined>>): string[] {
  const drift: string[] = [];
  for (const [path, want] of Object.entries(QA_FIXTURE_FILES)) {
    const got = remote[path];
    if (got === undefined) drift.push(`${path} is absent`);
    else if (got !== want) drift.push(`${path} differs from the generated copy (${got.length} bytes, expected ${want.length})`);
  }
  return drift;
}

export type QaCheckoutEvidence =
  | { readonly kind: "brokered" }
  | { readonly kind: "unenforced" }
  | { readonly kind: "none" };

export function qaCheckoutEvidence(rows: readonly AuditWireEntry[]): QaCheckoutEvidence {
  const policy = rows.filter((r) => r.action === "egress.policy");
  if (policy.some((r) => r.detail?.phase === "scm.broker" && r.detail?.reason === "checkout_repo")) return { kind: "brokered" };
  if (policy.some((r) => r.detail?.phase === "session.started" && r.detail?.enforced === false && r.detail?.aborted !== true)) {
    return { kind: "unenforced" };
  }
  return { kind: "none" };
}

export function isQaShotRef(ref: unknown): boolean {
  if (typeof ref !== "string" || !ref.startsWith("workspace:")) return false;
  const path = ref.slice("workspace:".length);
  return path === QA_SHOT_FILE || path.endsWith(`/${QA_SHOT_FILE}`);
}

export interface QaGate {
  readonly pass: boolean;
  readonly label: string;
}

export function qaAuditGates(rows: readonly AuditWireEntry[]): QaGate[] {
  const has = (action: string): boolean => rows.some((r) => r.action === action);
  const checkout = qaCheckoutEvidence(rows);
  const visionRead = rows.some((r) => r.action === "describe_image" && r.detail?.ok === true && isQaShotRef(r.detail?.ref));
  const posted = rows.some((r) => {
    if (r.action !== "slack.post_file") return false;
    const names = r.detail?.filenames;
    return Array.isArray(names) && names.includes(QA_SHOT_FILE);
  });
  return [
    {
      pass: checkout.kind !== "none",
      label:
        checkout.kind === "unenforced"
          ? "repo checkout: a session started with enforced:false (not aborted), and on that path checkout_repo writes no row — no row proves which tool fetched the repo; the heading gate below proves only that the fixture's derivation ran, not that the dev server served the page"
          : "repo checkout: an egress.policy row with phase scm.broker and reason checkout_repo landed (checkout_repo armed the git read broker for the clone)",
    },
    { pass: has("browser.navigate"), label: "browser: a browser.navigate audit row landed (the row carries no URL)" },
    { pass: has("browser.screenshot"), label: "browser: a browser.screenshot audit row landed (the row carries no URL)" },
    {
      pass: visionRead,
      label: `vision check: a describe_image row with ok:true read a workspace file named ${QA_SHOT_FILE} (no row ties that file to the browser.screenshot call)`,
    },
    {
      pass: posted,
      label: `show the result: a slack.post_file audit row posted ${QA_SHOT_FILE} to the thread`,
    },
  ];
}

export function namesQaHeading(text: string, heading: string): boolean {
  const [a, b] = heading.split(" ");
  if (!a || !b) return false;
  return new RegExp(`\\b${a}\\b[^A-Za-z0-9]{1,12}\\b${b}\\b`, "i").test(text);
}

export function writeQaFixture(outDir: string): string[] {
  const written: string[] = [];
  for (const [path, text] of Object.entries(QA_FIXTURE_FILES)) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(target);
  }
  return written;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf("--write");
  const outDir = at >= 0 ? process.argv[at + 1] : undefined;
  if (!outDir) {
    console.error("usage: npx tsx packages/core/scripts/e2e/qa-repo.ts --write <dir>  (then commit <dir>/qa-app/ to the fixture repo's base branch)");
    process.exit(2);
  }
  for (const path of writeQaFixture(outDir)) console.log(`wrote ${path}`);
}
