import { wireNeonOperationalStore, rotateUnifiedWindow, rotateDmSeat } from "./rotate-window-lib.js";

async function main() {
  const argv = process.argv.slice(2);
  const dmFlag = argv.indexOf("--dm");
  if (dmFlag !== -1) {
    const dmChannelId = argv[dmFlag + 1];
    if (!dmChannelId || dmChannelId.startsWith("--")) {
      console.error("--dm requires a DM channel id (e.g. --dm D0EXDMCH001)");
      process.exit(1);
    }
    argv.splice(dmFlag, 2);
    const org = argv[0] ?? process.env.E2E_ORG ?? "default";
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.error("DATABASE_URL is required (a live Neon connection string)");
      process.exit(1);
    }
    const store = await wireNeonOperationalStore(dbUrl);
    const r = await rotateDmSeat(store, org, dmChannelId);
    console.log("=== rotate-window (DM seat) ===");
    console.log(`org:            ${org}`);
    console.log(`dm channel:     ${dmChannelId}`);
    console.log(`registry key:   ${r.registryKey}`);
    console.log(`old generation: ${r.oldGeneration ?? "none (no prior row — first seat)"}`);
    console.log(`old token:      ${r.oldToken ?? "none"}`);
    console.log(`NEW token:      ${r.newRow.token}   <- eve session key (never seen before ⇒ fresh seat)`);
    console.log(`createdAt:      ${r.newRow.createdAt}`);
    return;
  }
  let windowId: string | undefined;
  const flag = argv.indexOf("--window");
  if (flag !== -1) {
    windowId = argv[flag + 1];
    if (!windowId || windowId.startsWith("--")) {
      console.error("--window requires a windowId (the grain's windowId — a surfaceKey for a solo window)");
      process.exit(1);
    }
    argv.splice(flag, 2);
  }
  const domain = argv[0];
  const org = argv[1] ?? process.env.E2E_ORG ?? "default";
  if (!domain) {
    console.error("usage: rotate-window.ts <domain> [org] [--window <windowId>]");
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required (a live Neon connection string)");
    process.exit(1);
  }

  const store = await wireNeonOperationalStore(dbUrl);
  const r = await rotateUnifiedWindow(store, org, domain, windowId);

  console.log("=== rotate-window ===");
  console.log(`org:            ${org}`);
  console.log(`domain:         ${domain}`);
  console.log(`window:         ${windowId ?? `${domain} (degenerate — the domain's cross-surface window)`}`);
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
