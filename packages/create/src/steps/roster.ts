import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AutomateResult, StepContext, WizardIO, WizardStep } from "../engine.js";

type RosterState =
  | { readonly kind: "unknown"; readonly detail: string }
  | { readonly kind: "known"; readonly detail: string; readonly clean: boolean };

function oeBin(cwd: string): { readonly command: string; readonly args: readonly string[] } | undefined {
  const manifest = join(cwd, "node_modules", "@open-everywhere", "core", "package.json");
  if (!existsSync(manifest)) return undefined;
  let rel: unknown;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
    rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.oe;
  } catch {
    return undefined;
  }
  if (typeof rel !== "string") return undefined;
  const script = join(dirname(manifest), rel);
  return existsSync(script) ? { command: process.execPath, args: [script] } : undefined;
}

export function inspectRoster(cwd: string): RosterState {
  if (!existsSync(join(cwd, "roster.config.ts"))) {
    return { kind: "unknown", detail: "roster.config.ts is missing — every Open Everywhere app declares its roster there" };
  }
  if (!existsSync(join(cwd, "roster.lock.json"))) {
    return {
      kind: "known",
      clean: false,
      detail: "roster.lock.json is missing — nothing has been REVIEWED, so `oe build` will refuse to mount anything",
    };
  }
  const bin = oeBin(cwd);
  if (bin === undefined) return { kind: "unknown", detail: "the `oe` CLI is not installed — run `npm install` first (the repo step covers this)" };
  try {
    execFileSync(bin.command, [...bin.args, "build", "--check"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { kind: "known", clean: true, detail: "the materialised slot tree matches roster.config.ts + roster.lock.json" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const first = `${e.stderr ?? ""}${e.stdout ?? ""}`.split("\n").find((l) => l.includes("·"))?.trim();
    return { kind: "known", clean: false, detail: first ?? "`oe build --check` reports the tree does not match the roster declaration" };
  }
}

function rosterNext(detail: string): string {
  if (/npm install/.test(detail)) return "npm install";
  if (/UNREVIEWED|missing — nothing has been REVIEWED/.test(detail)) return "review the contribution in roster.config.ts, then `npx oe build --accept` and read the roster.lock.json diff";
  if (/NOT BUILT/.test(detail)) return "npm run build";
  return "npx oe build";
}

export const rosterStep: WizardStep = {
  id: "roster",
  title: "Roster (roster.config.ts → the eve slot tree)",
  check(ctx: StepContext) {
    const state = inspectRoster(ctx.cwd);
    const satisfied = state.kind === "known" && state.clean;
    return { satisfied, detail: state.detail, next: satisfied ? undefined : rosterNext(state.detail) };
  },
  guide() {
    return {
      summary: "`roster.config.ts` declares what your agent can do; `oe build` materialises the eve slot tree from it.",
      instructions: [
        "roster.config.ts is terse: which packages contribute, which contributions this deployment EXCLUDES (with a reason), and which eve built-ins it takes away.",
        "roster.lock.json is the expanded, REVIEWED roll-call. Both are committed — the slot tree they generate is not.",
        "An upgrade that ships a NEW tool fails the build until you decide about it, then `npx oe build --accept` records the decision. There is no bypass flag.",
        "`npx oe build --show` prints the tree it would write, without writing it; `npm run lint:roster` is the gate.",
        "eve mounts NOTHING (and still boots) if the tree is missing — so never skip the build step.",
      ],
    };
  },
  async automate(ctx: StepContext, io: WizardIO): Promise<AutomateResult> {
    const state = inspectRoster(ctx.cwd);
    if (state.kind === "unknown") return { ran: false, ok: false, detail: state.detail };
    if (state.clean) return { ran: false, ok: true, detail: "nothing to materialise" };
    const bin = oeBin(ctx.cwd);
    if (bin === undefined) return { ran: false, ok: false, detail: "the `oe` CLI vanished between check and run" };
    io.print("Materialising the eve slot tree from roster.config.ts …");
    try {
      io.print(execFileSync(bin.command, [...bin.args, "build"], { cwd: ctx.cwd, encoding: "utf8" }).trimEnd());
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      io.print(`${e.stderr ?? ""}${e.stdout ?? ""}`.trimEnd());
      return {
        ran: true,
        ok: false,
        detail: "`oe build` refused. If it names an UNREVIEWED contribution, decide about it in roster.config.ts, then run `npx oe build --accept` yourself — a wizard must not review a capability for you.",
      };
    }
    const after = inspectRoster(ctx.cwd);
    return { ran: true, ok: after.kind === "known" && after.clean, detail: after.detail };
  },
};
