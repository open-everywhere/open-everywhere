import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { TEAMS_BRAND_ACCENT_COLOR, teamsAppManifestTemplate } from "@open-everywhere/provider-teams/agent/app-manifest.js";
import { TEAMS_ICON_SPECS } from "./teams-icons-generate.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const PINNED: Record<string, { readonly png: string; readonly svg: string }> = {
  "teams-app/color.png": {
    png: "7e9ce93dbf0414a6509b6cd8df3b5f1d2fcded333c66f86f3b6b911496106a89",
    svg: "8cea7bdcfd694fbe01b04c66e491d99b0ba93ee99b25e3d96eb5b2e237896e0b",
  },
  "teams-app/outline.png": {
    png: "806277cc2dfc1aa870219acc11522145214a591aac55a548660ecfe3b3303646",
    svg: "b654f48c76fd47a5a1749906256aae1da2c84d9d017ae7f3c1a9d683047cd0ba",
  },
};

const PAPER = [0xf5, 0xef, 0xe6] as const;
const INK = [0x1a, 0x1a, 0x1a] as const;
const EYE = [0xe8, 0x80, 0x2c] as const;

interface Decoded {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export function decodePng(buf: Buffer): Decoded {
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "not a PNG");
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data[9]!;
      assert.equal(data[8], 8, "decodePng: only 8-bit samples");
      assert.equal(data[12], 0, "decodePng: no interlace");
      assert.ok(colourType === 2 || colourType === 6, `decodePng: colour type ${colourType} is not 2 or 6`);
    } else if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const bpp = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * bpp);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter];
      assert.ok(pred !== undefined, `decodePng: unknown filter ${filter}`);
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = out[i * bpp]!;
    rgba[i * 4 + 1] = out[i * bpp + 1]!;
    rgba[i * 4 + 2] = out[i * bpp + 2]!;
    rgba[i * 4 + 3] = bpp === 4 ? out[i * bpp + 3]! : 255;
  }
  return { width, height, rgba };
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const near = (img: Decoded, i: number, rgb: readonly number[], tol = 6): boolean =>
  rgb.every((v, k) => Math.abs(img.rgba[i * 4 + k]! - v) <= tol) && img.rgba[i * 4 + 3] === 255;
const share = (img: Decoded, pred: (i: number) => boolean): number => {
  let hits = 0;
  for (let i = 0; i < img.width * img.height; i++) if (pred(i)) hits++;
  return hits / (img.width * img.height);
};

export function colourIconProblems(img: Decoded): string[] {
  const problems: string[] = [];
  if (img.width !== 192 || img.height !== 192) problems.push(`color.png is ${img.width}×${img.height}, not 192×192`);
  if (share(img, (i) => img.rgba[i * 4 + 3] !== 255) > 0) problems.push("color.png has transparent pixels; the full-bleed mark is opaque");
  const corners = [0, img.width - 1, (img.height - 1) * img.width, img.width * img.height - 1];
  if (!corners.slice(0, 2).every((i) => near(img, i, PAPER))) problems.push("color.png's top corners are not the brand paper colour");
  if (!corners.slice(2).every((i) => near(img, i, INK))) problems.push("color.png's bottom corners are not the brand ink colour (the ledge)");
  if (share(img, (i) => near(img, i, PAPER)) < 0.2) problems.push("color.png holds too little brand paper");
  if (share(img, (i) => near(img, i, INK)) < 0.3) problems.push("color.png holds too little brand ink");
  if (share(img, (i) => near(img, i, EYE)) < 0.005) problems.push("color.png holds no brand eye orange");
  return problems;
}

export function outlineIconProblems(img: Decoded): string[] {
  const problems: string[] = [];
  if (img.width !== 32 || img.height !== 32) problems.push(`outline.png is ${img.width}×${img.height}, not 32×32`);
  const a = (i: number) => img.rgba[i * 4 + 3]!;
  const white = (i: number) => img.rgba[i * 4] === 255 && img.rgba[i * 4 + 1] === 255 && img.rgba[i * 4 + 2] === 255;
  if (share(img, (i) => a(i) > 0 && !white(i)) > 0) problems.push("outline.png has a visible pixel that is not white");
  if (![0, img.width - 1, (img.height - 1) * img.width, img.width * img.height - 1].every((i) => a(i) === 0))
    problems.push("outline.png's corners are not transparent");
  if (share(img, (i) => a(i) === 0) < 0.25) problems.push("outline.png has too little transparent background");
  if (share(img, (i) => a(i) === 255) < 0.2) problems.push("outline.png has too little solid glyph");
  return problems;
}

for (const spec of TEAMS_ICON_SPECS) {
  const pin = PINNED[spec.out];
  ok(pin !== undefined, `${spec.out}: the generator's output has a pinned hash`);
  ok(existsSync(join(REPO_ROOT, spec.source)), `${spec.out}: its brand master ${spec.source} exists`);
  const svgSha = sha(readFileSync(join(REPO_ROOT, spec.source)));
  const pngSha = sha(readFileSync(join(REPO_ROOT, spec.out)));
  ok(
    svgSha === pin!.svg,
    `${spec.out}: its master ${spec.source} changed (sha256 ${svgSha}). Run scripts/teams-icons-generate.ts, then update PINNED here.`,
  );
  ok(
    pngSha === pin!.png,
    `${spec.out}: the shipped icon is not the one rendered from ${spec.source} (sha256 ${pngSha}). Run scripts/teams-icons-generate.ts; never swap the file by hand.`,
  );
}

const colour = decodePng(readFileSync(join(REPO_ROOT, "teams-app/color.png")));
const outline = decodePng(readFileSync(join(REPO_ROOT, "teams-app/outline.png")));
ok(colourIconProblems(colour).length === 0, `color.png: ${colourIconProblems(colour).join("; ")}`);
ok(outlineIconProblems(outline).length === 0, `outline.png: ${outlineIconProblems(outline).join("; ")}`);

{
  const manifest = JSON.parse(teamsAppManifestTemplate()) as { icons: { color: string; outline: string }; accentColor: string };
  ok(manifest.icons.color === "color.png" && manifest.icons.outline === "outline.png", "the manifest names the two shipped icons");
  ok(manifest.accentColor === TEAMS_BRAND_ACCENT_COLOR, "the manifest carries the brand accent colour");
  ok(TEAMS_BRAND_ACCENT_COLOR.toLowerCase() === "#1a1a1a", "the brand accent colour is the brand ink (brand/README.md)");
}

{
  const flat = (w: number, h: number, rgba: readonly number[]): Decoded => {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
    return { width: w, height: h, rgba: px };
  };
  ok(colourIconProblems(flat(192, 192, [0x58, 0x65, 0xf2, 255])).length > 0, "NEGATIVE CONTROL: a flat non-brand 192×192 tile fails the brand palette");
  ok(colourIconProblems(flat(96, 96, [...PAPER, 255])).length > 0, "NEGATIVE CONTROL: a colour icon at the wrong size fails");
  ok(outlineIconProblems(flat(32, 32, [0, 0, 0, 255])).length > 0, "NEGATIVE CONTROL: an opaque black outline icon fails");
  const grey = flat(32, 32, [0, 0, 0, 0]);
  grey.rgba.set([128, 128, 128, 255], (16 * 32 + 16) * 4);
  ok(outlineIconProblems(grey).some((p) => p.includes("not white")), "NEGATIVE CONTROL: one grey glyph pixel fails the white-only rule");
}

console.log(`teams-icons: ${n} checks passed`);
