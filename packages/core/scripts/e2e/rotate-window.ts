import { wireNeonOperationalStore, rotateUnifiedWindow } from "./rotate-window-lib.js";

async function main() {
  const domain = process.argv[2];
  const org = process.argv[3] ?? process.env.E2E_ORG ?? "default";
  if (!domain) {
    console.error("usage: rotate-window.ts <domain> [org]");
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required (a live Neon connection string)");
    process.exit(1);
  }

  const store = await wireNeonOperationalStore(dbUrl);
  const r = await rotateUnifiedWindow(store, org, domain);

  console.log("=== rotate-window ===");
  console.log(`org:            ${org}`);
  console.log(`domain:         ${domain}`);
  console.log(`registry key:   ${r.registryKey}`);
  console.log(`old generation: ${r.oldGeneration ?? "none (no prior row)"}`);
  console.log(`old token:      ${r.oldToken ?? "none"}`);
  console.log(`minted generation (in token): ${r.mintedGeneration}`);
  console.log(`NEW token:      ${r.newRow.token}   <- eve session key (never seen before ⇒ fresh window)`);
  console.log(`row int counter: ${r.newRow.generation}   (separate bookkeeping, not the eve key)`);
  console.log(`createdAt:      ${r.newRow.createdAt}`);
  console.log(`handoffNote:    ${r.newRow.handoffNote ?? "null (empty window ✓)"}`);
}

main().catch((e) => {
  console.error("ROTATE FAILED:", e);
  process.exit(1);
});
