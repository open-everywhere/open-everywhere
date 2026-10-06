import {
  resolveSelfHostBackendKind,
  selfHostBackendBootLog,
  JUSTBASH_BOOT_WARNING,
} from "../agent/sandbox/backend-select.js";

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

ok(resolveSelfHostBackendKind({}) === "docker", "unset OE_SANDBOX_BACKEND → docker (new default)");
ok(resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: "" }) === "docker", "empty string → docker");
ok(resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: "   " }) === "docker", "whitespace-only → docker");
ok(resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: "docker" }) === "docker", "explicit docker → docker");
ok(resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: " DOCKER " }) === "docker", "docker is trimmed + case-insensitive");

ok(resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: "justbash" }) === "justbash", "explicit justbash → justbash");
ok(resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: "JustBash " }) === "justbash", "justbash is trimmed + case-insensitive");

throwsWith(() => resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: "podman" }), 'unknown OE_SANDBOX_BACKEND="podman"', "unknown value throws (no silent fallback)");
throwsWith(() => resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: "vercel" }), 'unknown OE_SANDBOX_BACKEND="vercel"', "'vercel' is not a self-host backend → throws");

const jb = selfHostBackendBootLog("justbash");
ok(jb.warn === JUSTBASH_BOOT_WARNING, "justbash boot log carries the loud shared-filesystem warning");
ok(jb.warn !== undefined && jb.warn.includes("SHARES THE APP PROCESS FILESYSTEM"), "warning names the shared-filesystem hazard");
ok(jb.info.includes("justbash"), "justbash info line names the backend");

const dk = selfHostBackendBootLog("docker");
ok(dk.warn === undefined, "docker boot log emits NO warning (contained default)");
ok(dk.info.includes("docker"), "docker info line names the backend");

console.log(`✓ sandbox-backend: ${passed} assertions passed (default→docker, justbash opt-in+warn, unknown→throw)`);
