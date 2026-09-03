#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".eve",
  ".next",
  ".vercel",
  ".turbo",
  ".claude",
]);

const TOP_FILES = 25;

export function lineClasses(text) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      out.push("comment");
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.length === 0) {
      out.push("blank");
      continue;
    }
    if (line.startsWith("//")) {
      out.push("comment");
      continue;
    }
    if (line.startsWith("/*")) {
      out.push("comment");
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    out.push("code");
  }
  return out;
}

export function classifyLines(text) {
  let code = 0;
  let comment = 0;
  let blank = 0;
  for (const cls of lineClasses(text)) {
    if (cls === "comment") comment++;
    else if (cls === "blank") blank++;
    else code++;
  }
  return { code, comment, blank };
}

export function areaOf(rel) {
  const parts = rel.split("/");
  if (parts.length === 1) return "root";
  if (parts[0] === "packages") {
    if (parts[1] === "providers" && parts.length > 3) return `packages/providers/${parts[2]}`;
    return `packages/${parts[1]}`;
  }
  if (parts[0] === "agent") return parts.length > 2 ? `agent/${parts[1]}` : "agent";
  return parts[0];
}

const isSource = (rel) => EXTENSIONS.some((ext) => rel.endsWith(ext)) && !rel.split("/").some((seg) => SKIP_DIRS.has(seg));

function trackedFiles(root) {
  let listing;
  try {
    listing = execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  return listing.split("\0").filter((rel) => rel.length > 0 && isSource(rel)).sort();
}

function walkedFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs).split("\\").join("/");
      if (isSource(rel)) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

const sourceFiles = (root) => trackedFiles(root) ?? walkedFiles(root);

const ratio = (comment, code) => (code === 0 ? 0 : Number((comment / code).toFixed(3)));

export function measure(root) {
  const byArea = new Map();
  const files = [];
  for (const rel of sourceFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const counts = classifyLines(text);
    files.push({ file: rel, ...counts, ratio: ratio(counts.comment, counts.code) });
    const area = areaOf(rel);
    const row = byArea.get(area) ?? { area, files: 0, code: 0, comment: 0, blank: 0 };
    row.files++;
    row.code += counts.code;
    row.comment += counts.comment;
    row.blank += counts.blank;
    byArea.set(area, row);
  }

  const areas = [...byArea.values()]
    .map((row) => ({ ...row, ratio: ratio(row.comment, row.code) }))
    .sort((a, b) => b.comment - a.comment || a.area.localeCompare(b.area));

  const total = areas.reduce(
    (acc, row) => ({
      area: "TOTAL",
      files: acc.files + row.files,
      code: acc.code + row.code,
      comment: acc.comment + row.comment,
      blank: acc.blank + row.blank,
    }),
    { area: "TOTAL", files: 0, code: 0, comment: 0, blank: 0 },
  );
  total.ratio = ratio(total.comment, total.code);

  const commentHeaviest = [...files]
    .sort((a, b) => b.comment - a.comment || a.file.localeCompare(b.file))
    .slice(0, TOP_FILES);

  return { root, areas, total, commentHeaviest };
}

function pad(value, width, right = false) {
  const s = String(value);
  return right ? s.padStart(width) : s.padEnd(width);
}

function renderTable(report) {
  const rows = [...report.areas, report.total];
  const widths = {
    area: Math.max(4, ...rows.map((r) => r.area.length)),
    files: Math.max(5, ...rows.map((r) => String(r.files).length)),
    code: Math.max(4, ...rows.map((r) => String(r.code).length)),
    comment: Math.max(7, ...rows.map((r) => String(r.comment).length)),
    blank: Math.max(5, ...rows.map((r) => String(r.blank).length)),
  };
  const line = (r) =>
    `${pad(r.area, widths.area)}  ${pad(r.files, widths.files, true)}  ${pad(r.code, widths.code, true)}  ` +
    `${pad(r.comment, widths.comment, true)}  ${pad(r.blank, widths.blank, true)}  ${r.ratio.toFixed(2)}`;

  const out = [];
  out.push(
    `${pad("area", widths.area)}  ${pad("files", widths.files, true)}  ${pad("code", widths.code, true)}  ` +
      `${pad("comment", widths.comment, true)}  ${pad("blank", widths.blank, true)}  ratio`,
  );
  out.push("-".repeat(out[0].length));
  for (const r of report.areas) out.push(line(r));
  out.push("-".repeat(out[0].length));
  out.push(line(report.total));
  out.push("");
  out.push(`Top ${TOP_FILES} files by comment lines:`);
  const fileWidth = Math.max(...report.commentHeaviest.map((f) => f.file.length), 4);
  for (const f of report.commentHeaviest) {
    out.push(`  ${pad(f.file, fileWidth)}  ${pad(f.comment, 6, true)} comment  ${pad(f.code, 6, true)} code  ${f.ratio.toFixed(2)}`);
  }
  return out.join("\n");
}

function main(argv) {
  const json = argv.includes("--json");
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? REPO_ROOT : resolve(argv[rootFlag + 1] ?? ".");
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`✗ tidy/loc: --root ${root} is not a directory`);
    process.exit(1);
  }
  const report = measure(root);
  console.log(json ? JSON.stringify(report, null, 2) : renderTable(report));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
