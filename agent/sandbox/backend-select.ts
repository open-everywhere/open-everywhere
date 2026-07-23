export type SelfHostBackendKind = "docker" | "justbash";

export const JUSTBASH_BOOT_WARNING =
  "[open-everywhere:sandbox] ⚠ justbash backend: the agent's shell SHARES THE APP PROCESS FILESYSTEM " +
  "(app files, container/OS). Dev + testing only — use docker() (default) or Vercel for any real deployment.";

export function resolveSelfHostBackendKind(env: NodeJS.ProcessEnv = process.env): SelfHostBackendKind {
  const raw = env.OE_SANDBOX_BACKEND;
  const kind = (raw ?? "").trim().toLowerCase();
  if (kind === "" || kind === "docker") return "docker";
  if (kind === "justbash") return "justbash";
  throw new Error(
    `[open-everywhere:sandbox] unknown OE_SANDBOX_BACKEND=${JSON.stringify(raw)} — valid values: ` +
      `docker (default) | justbash (dev only). Refusing to boot.`,
  );
}

export interface BackendBootLog {
  warn?: string;
  info: string;
}

export function selfHostBackendBootLog(kind: SelfHostBackendKind): BackendBootLog {
  if (kind === "justbash") {
    return {
      warn: JUSTBASH_BOOT_WARNING,
      info: "[open-everywhere:sandbox] off-Vercel sandbox backend = justbash (explicit OE_SANDBOX_BACKEND=justbash)",
    };
  }
  return {
    info: "[open-everywhere:sandbox] off-Vercel sandbox backend = docker (default; contained per-session fs, egress via proxy sidecar)",
  };
}
