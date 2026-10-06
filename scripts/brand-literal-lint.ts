import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const BRAND_PATTERN = /open ?everywhere/iu;

export const SCOPE = /^(?:packages\/core\/agent|packages\/adapters\/agent|packages\/providers\/[^/]+\/agent|agent)\//u;

export function isGenerated(path: string): boolean {
  return /\.generated\.ts$/u.test(path) || /(^|\/)docs-generated\.ts$/u.test(path) || /(^|\/)docs\/generated\//u.test(path);
}

interface AllowEntry {
  readonly file: string;
  readonly literal: string;
  readonly match?: "exact" | "substring";
  readonly why: string;
}

export const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "packages/core/agent/identity/bot-name.ts",
    literal: "open everywhere",
    why: "DEFAULT_AGENT_FULL_NAME — the wake token on a deployment that configures NO name.",
  },
  {
    file: "packages/core/agent/identity/bot-name.ts",
    literal: "Open Everywhere",
    why: "DEFAULT_AGENT_DISPLAY_NAME — the one display-name fallback every string reads through agentDisplayName().",
  },
  {
    file: "packages/core/agent/status/status.ts",
    literal: "*Open Everywhere — current work*",
    why: "a LEGACY pinned-status header in PINNED_HEADERS, so a pin posted before OPE-2334 is still recognised as ours.",
  },
  {
    file: "packages/core/agent/status/status.ts",
    literal: "*OpenEverywhere — current work*",
    why: "an older LEGACY pinned-status header in PINNED_HEADERS, for the same reason.",
  },
  {
    file: "packages/providers/slack/agent/app-manifest.ts",
    literal: "Open Everywhere",
    why: "SLACK_DEFAULT_APP_NAME — the manifest's fallback when neither --app-name nor identity.name names the app. This module imports nothing, so it cannot read core's constant.",
  },
  {
    file: "packages/providers/teams/agent/app-manifest.ts",
    literal: "Open Everywhere",
    why: "TEAMS_DEFAULT_APP_NAME — the same fallback for the Teams manifest, in a module that imports nothing.",
  },
  {
    file: "packages/core/agent/tools/agent_version.ts",
    literal: "the Open Everywhere package version",
    match: "substring",
    why: "names the PACKAGE whose version the tool reports — the product, not the agent.",
  },
  {
    file: "packages/core/agent/tools/agent_version.ts",
    literal: "The Open Everywhere package version",
    match: "substring",
    why: "the same package-version field, in the output schema.",
  },
  {
    file: "packages/core/agent/ops/server.ts",
    literal: "running/deploying Open Everywhere",
    match: "substring",
    why: "an operator-plane MCP tool description about deploying the PRODUCT, read by the operator's coding agent, not by this agent.",
  },
  {
    file: "packages/core/agent/scaffold/roster-fs.ts",
    literal: "Every Open Everywhere app declares its roster there",
    match: "substring",
    why: "operator-CLI output about the PRODUCT's app layout.",
  },
  {
    file: "packages/core/agent/scaffold/app-root.ts",
    literal: "is not an Open Everywhere app",
    match: "substring",
    why: "operator-CLI output about the PRODUCT's app layout.",
  },
  {
    file: "packages/core/agent/scaffold/app-root.ts",
    literal: "No Open Everywhere app found",
    match: "substring",
    why: "operator-CLI output about the PRODUCT's app layout.",
  },
  {
    file: "packages/providers/teams/agent/ops.ts",
    literal: "before Open Everywhere's own fence",
    match: "substring",
    why: "an operator preflight line that names the PRODUCT's access fence, beside Microsoft's.",
  },
  {
    file: "packages/core/agent/settings/settings.ts",
    literal: "It REPLACES the brand there",
    match: "substring",
    why: "the identity.name schema summary DOCUMENTS the brand wake tokens and when they stop matching — operator documentation, rendered into the configuration reference.",
  },
  {
    file: "packages/core/agent/settings/settings.ts",
    literal: "The agent's SHORT name (OPE-2334)",
    match: "substring",
    why: "the identity.shortName schema summary documents the same brand wake tokens.",
  },
  {
    file: "agent/settings/settings.ts",
    literal: "Open Everywhere",
    why: "the test bed's OWN configured identity.name — a setting value, which is exactly where a name belongs.",
  },
];

export interface BrandHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

interface LiteralSegment {
  readonly line: number;
  readonly text: string;
}

const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/u;

export function literalSegments(source: string): LiteralSegment[] {
  const out: LiteralSegment[] = [];
  let line = 1;
  let i = 0;
  let last = "";
  let lastWordEnd = 0;
  const parenStack: boolean[] = [];
  const templateStack: number[] = [];
  let depth = 0;
  const n = source.length;
  const readTemplate = (): void => {
    let text = "";
    const startLine = line;
    while (i < n) {
      const c = source[i]!;
      if (c === "\\") {
        text += source.slice(i, i + 2);
        if (source[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        out.push({ line: startLine, text });
        last = "`";
        return;
      }
      if (c === "$" && source[i + 1] === "{") {
        i += 2;
        out.push({ line: startLine, text });
        templateStack.push(depth);
        depth++;
        last = "{";
        return;
      }
      if (c === "\n") line++;
      text += c;
      i++;
    }
    out.push({ line: startLine, text });
  };
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      for (let k = i; k < end; k++) if (source[k] === "\n") line++;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let text = "";
      const startLine = line;
      i++;
      while (i < n && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\") {
          text += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        text += source[i];
        i++;
      }
      i++;
      out.push({ line: startLine, text });
      last = c;
      continue;
    }
    if (c === "`") {
      i++;
      readTemplate();
      continue;
    }
    if (c === "/") {
      const before = source.slice(Math.max(0, lastWordEnd - 12), lastWordEnd);
      const isRegex = REGEX_PRECEDERS.has(last) || (/[\w$]/u.test(last) && REGEX_KEYWORDS.test(before));
      if (isRegex) {
        i++;
        let inClass = false;
        while (i < n && source[i] !== "\n") {
          const r = source[i]!;
          if (r === "\\") {
            i += 2;
            continue;
          }
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/iu.test(source[i]!)) i++;
        last = "/regex";
        continue;
      }
    }
    if (c === "(") {
      const before = source.slice(Math.max(0, lastWordEnd - 8), lastWordEnd);
      parenStack.push(/[\w$]/u.test(last) && /(?:^|[^\w$])(?:if|while|for|with)$/u.test(before));
      last = "(";
      i++;
      continue;
    }
    if (c === ")") {
      last = parenStack.pop() === true ? "" : ")";
      i++;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === depth) {
        templateStack.pop();
        i++;
        readTemplate();
        continue;
      }
    }
    if (/[\w$]/u.test(c)) {
      while (i < n && /[\w$]/u.test(source[i]!)) i++;
      last = source[i - 1]!;
      lastWordEnd = i;
      continue;
    }
    last = c;
    i++;
  }
  return out;
}

export function brandLiterals(file: string, source: string): BrandHit[] {
  return literalSegments(source)
    .filter((seg) => BRAND_PATTERN.test(seg.text))
    .map((seg) => ({ file, line: seg.line, text: seg.text }));
}

function scopedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "packages", "agent"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter((p) => SCOPE.test(p) && /\.(ts|tsx|mts)$/u.test(p) && !p.endsWith(".d.ts") && !isGenerated(p))
    .filter((p) => !/(^|\/)(scripts|tests?)\//u.test(p) && !/-test\.ts$/u.test(p));
}

export function judge(hits: readonly BrandHit[], allowlist: readonly AllowEntry[] = ALLOWLIST): { refused: BrandHit[]; stale: AllowEntry[] } {
  const used = new Set<AllowEntry>();
  const refused: BrandHit[] = [];
  for (const hit of hits) {
    const entry = allowlist.find(
      (e) => e.file === hit.file && (e.match === "substring" ? hit.text.includes(e.literal) : hit.text === e.literal),
    );
    if (entry === undefined) refused.push(hit);
    else used.add(entry);
  }
  return { refused, stale: allowlist.filter((e) => !used.has(e)) };
}

function main(): void {
  const hits = scopedFiles().flatMap((file) => brandLiterals(file, readFileSync(join(REPO_ROOT, file), "utf8")));
  const { refused, stale } = judge(hits);
  if (refused.length === 0 && stale.length === 0) {
    console.log(`✓ brand-literals: no unallowed brand literal in runtime agent code (${hits.length} allowlisted use(s))`);
    return;
  }
  for (const hit of refused) {
    console.error(`✗ ${hit.file}:${hit.line} — a brand literal in a runtime string: ${JSON.stringify(hit.text.slice(0, 120))}`);
  }
  if (refused.length > 0) {
    console.error(
      "  Read the deployment's name with agentDisplayName() (identity/bot-name.ts) or use a neutral phrase.\n" +
        "  A legitimate brand use (a package name, the product's own CLI) goes in ALLOWLIST in scripts/brand-literal-lint.ts, with its reason.",
    );
  }
  for (const entry of stale) {
    console.error(`✗ stale allowlist entry: ${entry.file} — no literal holds ${JSON.stringify(entry.literal)} any more. Remove the entry.`);
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
