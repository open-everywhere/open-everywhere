import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DAC_BYPASS_CAPS = ["cap_dac_override", "cap_dac_read_search"] as const;

export function writeBitsBite(): boolean {
  const base = mkdtempSync(join(tmpdir(), "oe-dac-fence-probe-"));
  const fenced = join(base, "fenced");
  try {
    mkdirSync(fenced);
    chmodSync(fenced, 0o555);
    try {
      writeFileSync(join(fenced, "probe"), "x");
      return false;
    } catch {
      return true;
    }
  } finally {
    try {
      chmodSync(fenced, 0o755);
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  }
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export function dacFenceScript(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].map(shellQuote).join(" ");
}

const CAPSH_CANDIDATES = ["/usr/sbin/capsh", "/sbin/capsh", "capsh"] as const;

interface CapshLookup {
  readonly path?: string;
  readonly presentButUnusable: readonly string[];
}

function findCapsh(): CapshLookup {
  const presentButUnusable: string[] = [];
  for (const candidate of CAPSH_CANDIDATES) {
    const probe = spawnSync(candidate, ["--has-p=cap_setpcap"], { stdio: "ignore" });
    if (probe.error !== undefined) continue;
    if (probe.status === 0) return { path: candidate, presentButUnusable };
    presentButUnusable.push(candidate);
  }
  return { presentButUnusable };
}

export function withoutDacOverride(cmd: string, args: readonly string[]): { cmd: string; args: string[] } {
  const { path: capsh, presentButUnusable } = findCapsh();
  if (capsh === undefined) {
    const cause =
      presentButUnusable.length > 0
        ? `\`capsh\` at ${presentButUnusable.join(", ")} ran and answered that this process may not drop from the ` +
          "bounding set (no CAP_SETPCAP). Installing libcap will not help — grant CAP_SETPCAP, or"
        : `no \`capsh\` on this host (tried ${CAPSH_CANDIDATES.join(", ")}). Install libcap2-bin/libcap, or`;
    throw new Error(
      `dac-fence: cannot drop CAP_DAC_OVERRIDE — ${cause} run the suite as an unprivileged user. ` +
        "This process bypasses the POSIX write bits, so every write-fence assertion would pass " +
        "without proving anything.",
    );
  }
  return { cmd: capsh, args: [`--drop=${DAC_BYPASS_CAPS.join(",")}`, "--", "-c", dacFenceScript(cmd, args)] };
}

export function assertWriteBitsBite(what: string): void {
  if (writeBitsBite()) return;
  throw new Error(
    `dac-fence: ${what} proves a write is REFUSED through the POSIX write bits, and this process ` +
      "BYPASSES them (CAP_DAC_OVERRIDE), so the assertion could not fail. Run the integration tier " +
      "through `npm run test:integration`, which drops the capability for the whole tier " +
      "(scripts/suite-lock-run.ts), or run it as an unprivileged user.",
  );
}
