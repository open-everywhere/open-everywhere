import { wireNeonOperationalStore, rotateAllSeatsCarryingTail } from "./rotate-window-lib.js";

async function main() {
  const argv = process.argv.slice(2);
  const prefixFlag = argv.indexOf("--prefix");
  let prefix = "oe-domain::";
  if (prefixFlag !== -1) {
    const v = argv[prefixFlag + 1];
    if (!v || v.startsWith("--")) {
      console.error("--prefix requires a value (e.g. --prefix oe-domain::)");
      process.exit(1);
    }
    prefix = v;
    argv.splice(prefixFlag, 2);
  }
  const org = argv[0] ?? process.env.E2E_ORG ?? "default";
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required (a live Neon connection string)");
    process.exit(1);
  }

  const store = await wireNeonOperationalStore(dbUrl);
  const atIso = new Date().toISOString();
  const { rotated, vanished } = await rotateAllSeatsCarryingTail(store, org, atIso, prefix);

  console.log(`=== rotate-all-windows (org=${org}, prefix="${prefix}") ===`);
  for (const r of rotated) {
    console.log(`  ${r.registryKey}: g${r.oldGeneration} -> g${r.newRow.generation}  tailCarried=${r.tailCarried}`);
  }
  if (vanished.length > 0) {
    console.log(`  (skipped — vanished between list and rotate: ${vanished.join(", ")})`);
  }
  const totalTail = rotated.reduce((sum, r) => sum + r.tailCarried, 0);
  console.log(`✓ rotated ${rotated.length} row(s), carried ${totalTail} tail entr${totalTail === 1 ? "y" : "ies"} total.`);
}

main().catch((e) => {
  console.error("ROTATE-ALL FAILED:", e);
  process.exit(1);
});
