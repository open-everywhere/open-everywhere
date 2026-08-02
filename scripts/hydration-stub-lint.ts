import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DRIVES_HYDRATION = /\bfanOutDelivery\b|\bhydratePointer\b/;
const HAS_STUB = /registerEntityRead|resetEntityReadForTest|hydrate\s*:|\bread\s*:|OE_ALLOW_TEST_NETWORK/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "coverage"]);

function testFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p);
      else if (name.endsWith("-test.ts")) out.push(p);
    }
  };
  walk(root);
  return out;
}

const reds: string[] = [];
for (const file of testFiles(".")) {
  const src = readFileSync(file, "utf8");
  if (DRIVES_HYDRATION.test(src) && !HAS_STUB.test(src)) {
    reds.push(
      `${file}: drives fanOutDelivery/hydratePointer but shows no hydration stub. Register one after ` +
        `importing the fan-out path — registerEntityRead({ platform: "github", read: async () => ({ status: "gone" }) }) — ` +
        `or pass deps.read (hydrate: { read }). If a live call is genuinely intended, set OE_ALLOW_TEST_NETWORK=1.`,
    );
  }
}

if (reds.length > 0) {
  console.error(`✗ hydration-stub: ${reds.length} fan-out test(s) reach hydration without a stub (would hit the network):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log("✓ hydration-stub: every fan-out/hydration test stubs the entity reader (no live network in the suite)");
