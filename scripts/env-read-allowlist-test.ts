import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_READ_ALLOWLIST, auditEnvReads, type AllowEntry, type EnvAllowlist } from "./env-read-allowlist.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(root, "scripts", "env-docs-lint.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

const scratchRoots: string[] = [];

function fixture(names: readonly string[], root = "agent"): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-env-allowlist-"));
  scratchRoots.push(dir);
  mkdirSync(join(dir, root), { recursive: true });
  const body = names.map((n, i) => `export const probe${i} = process.env.${n};`).join("\n");
  writeFileSync(join(dir, root, "probe.ts"), `${body}\n`);
  writeFileSync(join(dir, ".env.example"), `${names.map((n) => `${n}=`).join("\n")}\n`);
  return dir;
}

function lint(cwd: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, LINT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function synthetic(entries: Record<string, AllowEntry>): EnvAllowlist {
  return new Map(Object.entries(entries));
}

function readsOf(...names: string[]): ReadonlyMap<string, readonly string[]> {
  return new Map(names.map((n) => [n, [`agent/fixture-${n.toLowerCase()}.ts`]]));
}

function main(): void {
  {
    const r = lint(fixture(["OE_SYNTHETIC_KNOB"]));
    ok(r.code !== 0, `a new unallowlisted env read fails the lint (exit ${r.code})`);
    ok(r.out.includes("ENV READ NOT ALLOWLISTED"), "…under the allowlist arm's own headline, not another arm's");
    ok(r.out.includes("process.env.OE_SYNTHETIC_KNOB"), "…naming the variable that caused it");
    ok(r.out.includes("agent/probe.ts"), "…and the file that reads it, so the author has somewhere to go");
    ok(r.out.includes("move it to settings/config"), "…and says where the value belongs instead");
  }

  {
    const r = lint(fixture(["OE_ORG"]));
    const unallowed = r.out.split("\n").filter((l) => l.includes("ENV READ NOT ALLOWLISTED"));
    ok(unallowed.length === 0, `an allowlisted read raises no unallowlisted red (got: ${unallowed.join(" | ")})`);
    ok(r.out.includes("STALE ALLOWLIST ENTRY"), "…while the shrink direction DOES fire for the entries this tree stopped reading");
    ok(r.out.includes("GITHUB_TOKEN"), "…naming one of them");
    ok(r.code !== 0, "…and a stale entry fails the lint, so the list can only shrink");
  }

  {
    const r = lint(fixture(["OE_SYNTHETIC_KNOB"], "scripts"));
    const named = r.out.split("\n").filter((l) => l.includes("ENV READ NOT ALLOWLISTED"));
    ok(named.length === 0, `a scripts/ env read is out of scope and raises no red (got: ${named.join(" | ")})`);
  }

  {
    const list = synthetic({ OE_GONE: { klass: "secret", why: "a token nothing reads any more." } });
    const reds = auditEnvReads(new Map(), list);
    ok(reds.length === 1 && reds[0].includes("STALE ALLOWLIST ENTRY"), "an entry with no matching read is a red");
    ok(reds[0].includes("OE_GONE") && reds[0].includes("secret"), "…naming the entry and its class");
    ok(auditEnvReads(readsOf("OE_GONE"), list).length === 0, "…and is silent while the read is still there");
  }

  {
    const untick = synthetic({ OE_KNOB: { klass: "pending-migration", why: "we will move it later." } });
    const reds = auditEnvReads(readsOf("OE_KNOB"), untick);
    ok(reds.length === 1 && reds[0].includes("UNTICKETED PENDING MIGRATION"), "a backlog entry naming no ticket is a red");

    const ticked = synthetic({ OE_KNOB: { klass: "pending-migration", why: "OPE-1153: a tuning number." } });
    ok(auditEnvReads(readsOf("OE_KNOB"), ticked).length === 0, "…and naming one clears it — the negative control");

    const permanent = synthetic({ OE_KNOB: { klass: "secret", why: "the bearer token this deployment signs with." } });
    ok(auditEnvReads(readsOf("OE_KNOB"), permanent).length === 0, "…and a permanent class needs no ticket");
  }

  {
    const bare = synthetic({ OE_KNOB: { klass: "secret", why: "" } });
    const reds = auditEnvReads(readsOf("OE_KNOB"), bare);
    ok(reds.length === 1 && reds[0].includes("UNREASONED ALLOWLIST ENTRY"), "an entry with no reason is a red");
    ok(reds[0].includes("OE_KNOB"), "…naming it");
    const label = synthetic({ OE_KNOB: { klass: "secret", why: "  ok  " } });
    ok(auditEnvReads(readsOf("OE_KNOB"), label)[0]?.includes("UNREASONED"), "…and a bare label does not count as one");
    const real = synthetic({ OE_KNOB: { klass: "secret", why: "the bearer token this deployment signs with." } });
    ok(auditEnvReads(readsOf("OE_KNOB"), real).length === 0, "…while a real reason clears it — the negative control");
  }

  {
    const list = synthetic({
      OE_A: { klass: "identity", why: "which org this is." },
      OE_B: { klass: "pending-migration", why: "OPE-1153: a cap." },
    });
    ok(auditEnvReads(readsOf("OE_A", "OE_B"), list).length === 0, "a matching inventory and allowlist produce no reds");
  }

  {
    const census = new Map<string, number>();
    for (const [, e] of ENV_READ_ALLOWLIST) census.set(e.klass, (census.get(e.klass) ?? 0) + 1);
    const expected: Record<string, number> = {
      "settings-lever": 0,
      secret: 20,
      connection: 26,
      identity: 20,
      platform: 11,
      "pending-migration": 35,
    };
    for (const [klass, n] of Object.entries(expected)) {
      ok(
        (census.get(klass) ?? 0) === n,
        `class ${klass} holds ${n} entries (found ${census.get(klass) ?? 0}) — if you meant to change this, say so here`,
      );
    }
    ok(ENV_READ_ALLOWLIST.size === 112, `the allowlist holds 112 names (found ${ENV_READ_ALLOWLIST.size})`);
  }

  {
    const unticketed = [...ENV_READ_ALLOWLIST].filter(([, e]) => e.klass === "pending-migration" && !/OPE-\d+/.test(e.why));
    ok(unticketed.length === 0, `every real backlog entry names a ticket (unticketed: ${unticketed.map(([n]) => n).join(", ")})`);
    const reasonless = [...ENV_READ_ALLOWLIST].filter(([, e]) => e.why.trim().length < 10);
    ok(reasonless.length === 0, `every real entry carries a reason (bare: ${reasonless.map(([n]) => n).join(", ")})`);
  }

  {
    const r = lint(fixture(["OE_ORG"]));
    ok(!r.out.includes("STALE REVERSE_SCAN_SELF"), "the self-exclusion list names files that exist");
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  (${passed} assertion(s) passed before the failure)`);
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });

console.log(`\n✓ env-read allowlist ratchet: ${passed} assertions passed (${ENV_READ_ALLOWLIST.size} names allowed)\n`);
