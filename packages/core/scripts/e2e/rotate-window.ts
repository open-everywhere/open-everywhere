import { wireNeonOperationalStore, rotateUnifiedWindow, parseRotateArgs, checkOrgAllowed, WindowTargetRefused, awaitRotationIdle, generationNotIdleMessage } from "./rotate-window-lib.js";
import { dmAnchorDomain } from "../../agent/channels/window-key.js";
import { guardStoreIdentityBeforeWrite } from "../store-identity-guard.js";
import { loadAppDomains } from "./app-config.js";

async function main() {
  const parsed = parseRotateArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const { target } = parsed;
  const domains = await loadAppDomains();

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required (a live Neon connection string)");
    process.exit(1);
  }
  const store = await wireNeonOperationalStore(dbUrl);

  await guardStoreIdentityBeforeWrite(store, target.org);

  const allowed = await checkOrgAllowed(store, target.org, target.allowNewOrg);
  if (!allowed.ok) {
    console.error(allowed.error);
    process.exit(1);
  }

  if (target.waitIdleMs !== undefined) {
    const window = target.kind === "dm" ? dmAnchorDomain(target.dmSurfaceKey) : (target.windowId ?? target.domain);
    const idle = await awaitRotationIdle(store, target.org, window, { timeoutMs: target.waitIdleMs });
    if (!idle.ok) {
      console.error(generationNotIdleMessage(idle.registryKey, idle.result));
      process.exit(3);
    }
    for (const row of idle.idle) console.log(`wait-idle:      ${row.registryKey} owes no job (waited ${Math.round(row.waitedMs / 1000)}s)`);
  }

  if (target.kind === "dm") {
    const r = await rotateUnifiedWindow(store, target.org, dmAnchorDomain(target.dmSurfaceKey), undefined, { force: target.force, domains });
    console.log("=== rotate-window (DM seat) ===");
    console.log(`org:            ${target.org}`);
    console.log(`dm surface:     ${target.dmSurfaceKey}`);
    console.log(`registry key:   ${r.registryKey}`);
    console.log(`old generation: ${r.oldGeneration ?? "none (no prior row — first seat)"}`);
    console.log(`old token:      ${r.oldToken ?? "none"}`);
    console.log(`NEW token:      ${r.newRow.token}   <- eve session key (never seen before ⇒ fresh seat)`);
    console.log(`createdAt:      ${r.newRow.createdAt}`);
    printWork(r.work);
    return;
  }

  const r = await rotateUnifiedWindow(store, target.org, target.domain, target.windowId, { force: target.force, domains });

  console.log("=== rotate-window ===");
  console.log(`org:            ${target.org}`);
  console.log(`domain:         ${target.domain}`);
  console.log(`window:         ${target.windowId ?? `${target.domain} (degenerate — the domain's cross-surface window)`}`);
  console.log(`registry key:   ${r.registryKey}`);
  console.log(`old generation: ${r.oldGeneration ?? "none (no prior row)"}`);
  console.log(`old token:      ${r.oldToken ?? "none"}`);
  console.log(`minted generation (in token): ${r.mintedGeneration}`);
  console.log(`NEW token:      ${r.newRow.token}   <- eve session key (never seen before ⇒ fresh window)`);
  console.log(`row int counter: ${r.newRow.generation}   (separate bookkeeping, not the eve key)`);
  console.log(`createdAt:      ${r.newRow.createdAt}`);
  console.log(`lastInputTokens: ${r.newRow.lastInputTokens ?? "null (no request on this generation yet ✓)"}`);
  printWork(r.work);
}

function printWork(work: Awaited<ReturnType<typeof rotateUnifiedWindow>>["work"]): void {
  if (work === null) {
    console.log("work session:   not rotated (the target is a work window, or the seat has no work-session row yet)");
    return;
  }
  console.log(`work session:   ${work.registryKey}`);
  console.log(`  old token:    ${work.oldToken}`);
  console.log(`  NEW token:    ${work.newRow.token}   <- fresh work session (never seen before)`);
}

main().catch((e) => {
  if (e instanceof WindowTargetRefused) console.error(e.message);
  else console.error("ROTATE FAILED:", e);
  process.exit(1);
});
