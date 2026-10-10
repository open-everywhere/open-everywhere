import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface TeamsIconSpec {
  readonly out: string;
  readonly source: string;
  readonly size: number;
  readonly recolour?: { readonly from: string; readonly to: string };
}

export const TEAMS_ICON_SPECS: readonly TeamsIconSpec[] = [
  { out: "teams-app/color.png", source: "brand/svg/mark-square.svg", size: 192 },
  { out: "teams-app/outline.png", source: "brand/svg/mark-mono-paper.svg", size: 32, recolour: { from: "#f5efe6", to: "#ffffff" } },
];

function render(browser: string, spec: TeamsIconSpec, work: string): void {
  let svg = readFileSync(join(REPO_ROOT, spec.source), "utf8");
  if (spec.recolour) svg = svg.split(spec.recolour.from).join(spec.recolour.to);
  svg = svg.replace("<svg ", `<svg style="display:block" width="${spec.size}" height="${spec.size}" `);
  const page = join(work, `${spec.size}.html`);
  writeFileSync(page, `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  execFileSync(
    browser,
    [
      "--headless",
      "--no-sandbox",
      "--hide-scrollbars",
      "--default-background-color=00000000",
      `--window-size=${spec.size},${spec.size}`,
      `--screenshot=${join(REPO_ROOT, spec.out)}`,
      `file://${page}`,
    ],
    { stdio: "ignore" },
  );
}

function main(): void {
  const at = process.argv.indexOf("--browser");
  const browser = at === -1 ? undefined : process.argv[at + 1];
  if (!browser) {
    console.error("usage: npx tsx scripts/teams-icons-generate.ts --browser <path to a Chromium or headless_shell binary>");
    process.exit(2);
  }
  const work = mkdtempSync(join(tmpdir(), "oe-teams-icons-"));
  for (const spec of TEAMS_ICON_SPECS) {
    render(browser, spec, work);
    const sha = (path: string) => createHash("sha256").update(readFileSync(join(REPO_ROOT, path))).digest("hex");
    console.log(`${spec.out}  sha256=${sha(spec.out)}  from ${spec.source} sha256=${sha(spec.source)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
