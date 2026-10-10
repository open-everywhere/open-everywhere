import {
  resolveSandboxBackend,
  resolveSelfHostBackendKind,
  selfHostBackendBootLog,
  JUSTBASH_BOOT_WARNING,
} from "../agent/sandbox/backend-select.js";
import { defineSettings, getSettings } from "@open-everywhere/core/agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throwsWith(fn: () => unknown, fragment: string, label: string): void {
  let threw = false;
  let error: unknown;
  try {
    fn();
  } catch (err) {
    threw = true;
    error = err;
  }
  if (!threw) {
    console.error(`✗ ${label} (expected a throw, got none)`);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(fragment)) {
    console.error(`✗ ${label} (threw, but not the refusal under test — expected "${fragment}", got: ${message})`);
    process.exit(1);
  }
  passed++;
}

const sandbox = (over: Partial<{ selfHostBackend: "docker" | "justbash"; useVercelSandbox: boolean }> = {}) => ({
  ...getSettings({}).sandbox,
  ...over,
});

ok(resolveSelfHostBackendKind(sandbox()) === "docker", "shipped sandbox.selfHostBackend → docker (the contained default)");
ok(resolveSandboxBackend(sandbox(), false) === "docker", "off a Vercel host with nothing declared → docker");
ok(resolveSandboxBackend(sandbox(), true) === "vercel", "a Vercel host → the Vercel Sandbox");

ok(resolveSelfHostBackendKind(sandbox({ selfHostBackend: "justbash" })) === "justbash", "declared justbash → justbash");
ok(resolveSandboxBackend(sandbox({ selfHostBackend: "justbash" }), false) === "justbash", "…and it runs off a Vercel host");
ok(resolveSandboxBackend(sandbox({ selfHostBackend: "justbash" }), true) === "vercel", "🔴 …and it is INERT on a Vercel host — the Vercel Sandbox always runs there");

ok(resolveSandboxBackend(sandbox({ useVercelSandbox: true }), false) === "vercel", "useVercelSandbox off a Vercel host → the Vercel Sandbox");
ok(resolveSandboxBackend(sandbox({ useVercelSandbox: true, selfHostBackend: "justbash" }), false) === "vercel", "…and it wins over the self-host backend");

throwsWith(() => defineSettings({ sandbox: { selfHostBackend: "podman" as never } }), 'sandbox.selfHostBackend: must be "docker" or "justbash"', "unknown backend fails settings load (no silent fallback)");
throwsWith(() => defineSettings({ sandbox: { selfHostBackend: "vercel" as never } }), 'sandbox.selfHostBackend: must be "docker" or "justbash"', "'vercel' is not a self-host backend → settings load refuses it");

delete process.env.VERCEL;
process.env.OE_SANDBOX_BACKEND = "justbash";
process.env.OE_PLATFORM = "vercel";
ok(resolveSandboxBackend(sandbox()) === "docker", "🔴 OE_SANDBOX_BACKEND and OE_PLATFORM set in the environment move NOTHING");
delete process.env.OE_SANDBOX_BACKEND;
delete process.env.OE_PLATFORM;

const jb = selfHostBackendBootLog("justbash");
ok(jb.warn === JUSTBASH_BOOT_WARNING, "justbash boot log carries the loud shared-filesystem warning");
ok(jb.warn !== undefined && jb.warn.includes("SHARES THE APP PROCESS FILESYSTEM"), "warning names the shared-filesystem hazard");
ok(jb.info.includes("justbash"), "justbash info line names the backend");

const dk = selfHostBackendBootLog("docker");
ok(dk.warn === undefined, "docker boot log emits NO warning (contained default)");
ok(dk.info.includes("docker"), "docker info line names the backend");

console.log(`✓ sandbox-backend: ${passed} assertions passed (default→docker, justbash opt-in+warn and inert on Vercel, useVercelSandbox, unknown→settings refusal)`);

// proves: AP-MOD-app-sandbox-backend-select

// proves: SET-081, SET-082
