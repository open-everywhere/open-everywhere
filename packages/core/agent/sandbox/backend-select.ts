import { onVercel } from "../access/platform.js";
import { getSettings, type AgentSettings, type SandboxBackendChoice } from "../settings/settings.js";

export type SelfHostBackendKind = SandboxBackendChoice;

export type SandboxBackendKind = "vercel" | SelfHostBackendKind;

export const JUSTBASH_BOOT_WARNING =
  "[open-everywhere:sandbox] ⚠ justbash backend: the agent's shell SHARES THE APP PROCESS FILESYSTEM " +
  "(app files, container/OS). Dev + testing only — use docker() (default) or Vercel for any real deployment.";

export function resolveSelfHostBackendKind(sandbox: AgentSettings["sandbox"] = getSettings().sandbox): SelfHostBackendKind {
  return sandbox.selfHostBackend;
}

export function resolveSandboxBackend(
  sandbox: AgentSettings["sandbox"] = getSettings().sandbox,
  vercelHost: boolean = onVercel(),
): SandboxBackendKind {
  if (vercelHost || sandbox.useVercelSandbox) return "vercel";
  return sandbox.selfHostBackend;
}

export function sandboxOnVercel(): boolean {
  return resolveSandboxBackend() === "vercel";
}

export interface BackendBootLog {
  warn?: string;
  info: string;
}

export function selfHostBackendBootLog(kind: SelfHostBackendKind): BackendBootLog {
  if (kind === "justbash") {
    return {
      warn: JUSTBASH_BOOT_WARNING,
      info: "[open-everywhere:sandbox] off-Vercel sandbox backend = justbash (declared: sandbox.selfHostBackend)",
    };
  }
  return {
    info: "[open-everywhere:sandbox] off-Vercel sandbox backend = docker (default; contained per-session fs; session egress is NOT behind the proxy sidecar — coarse allow-all/deny-all only)",
  };
}
