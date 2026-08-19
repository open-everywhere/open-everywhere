import { wireNeonOperationalStore, markAllSeatsForRotation } from "./rotate-window-lib.js";

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
  const { marked, vanished } = await markAllSeatsForRotation(store, org, atIso, prefix);

  console.log(`=== rotate-all-windows (org=${org}, prefix="${prefix}") ===`);
  for (const m of marked) {
    console.log(`  ${m.registryKey}: g${m.generation} marked, rotates on its next wake  tailPending=${m.tailPending}`);
  }
  if (vanished.length > 0) {
    console.log(`  (skipped — vanished between list and mark: ${vanished.join(", ")})`);
  }
  const totalTail = marked.reduce((sum, m) => sum + m.tailPending, 0);
  console.log(`✓ marked ${marked.length} seat(s). ${totalTail} recorded tail entr${totalTail === 1 ? "y is" : "ies are"} still in the store and ride across at each seat's next wake.`);
}

main().catch((e) => {
  console.error("ROTATE-ALL FAILED:", e);
  process.exit(1);
});
