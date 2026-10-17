import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function npmCommand(args: readonly string[]): [string, string[]] {
  if (process.platform !== "win32") return ["npm", [...args]];
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    .find((p): p is string => typeof p === "string" && p.endsWith(".js") && existsSync(p));
  if (!cli) throw new Error("npm-command: cannot find npm-cli.js beside this Node; run the script through `npm run`");
  return [process.execPath, [cli, ...args]];
}

export function localBinCommand(pkg: string, binName: string, args: readonly string[]): [string, string[]] {
  const manifestPath = join(process.cwd(), "node_modules", pkg, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
  const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (!rel) throw new Error(`npm-command: ${pkg} declares no \`${binName}\` bin`);
  return [process.execPath, [join(dirname(manifestPath), rel), ...args]];
}

export function npxCommand(args: readonly string[]): [string, string[]] {
  if (process.platform !== "win32") return ["npx", [...args]];
  const [node, [npmCli]] = npmCommand([]);
  const cli = join(dirname(npmCli!), "npx-cli.js");
  if (!existsSync(cli)) throw new Error(`npm-command: cannot find npx-cli.js beside ${npmCli}`);
  return [node, [cli, ...args]];
}

export function tsxCommand(repoRoot: string, args: readonly string[]): [string, string[]] {
  if (process.platform !== "win32") return [join(repoRoot, "node_modules", ".bin", "tsx"), [...args]];
  return [process.execPath, [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), ...args]];
}

export interface ChildResult {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  error?: (Error & { code?: unknown }) | undefined;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}

export function spawnFailure(result: Pick<ChildResult, "status" | "signal" | "error">, label: string): string | undefined {
  const signal = result.signal ? ` (signal ${result.signal})` : "";
  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : undefined;
    if (code === "ETIMEDOUT") return `${label} timed out and was killed${signal}`;
    if (code === "ENOBUFS") return `${label} overflowed its maxBuffer and was killed${signal}`;
    return `${label} did not start${code ? ` (${code})` : ""}: ${result.error.message}`;
  }
  if (result.status == null) return `${label} ended without an exit code${signal}`;
  return undefined;
}

const RELAYED_SIGNAL_CODES: ReadonlyMap<number, string> = new Map([
  [129, "SIGHUP"],
  [130, "SIGINT"],
  [134, "SIGABRT"],
  [135, "SIGBUS"],
  [137, "SIGKILL"],
  [139, "SIGSEGV"],
  [143, "SIGTERM"],
]);

export class IncompleteChildRun extends Error {
  readonly output: string;
  constructor(reason: string, output: string) {
    super(
      `INCOMPLETE RUN — ${reason}. Its output is cut, so it is not graded as an answer. ` +
        `Output so far (${output.length} chars):\n${output === "" ? "(none)" : output}`,
    );
    this.name = "IncompleteChildRun";
    this.output = output;
  }
}

export function finishedRun(result: ChildResult, label: string): { status: number; stdout: string; stderr: string } {
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const relayed = result.status == null ? undefined : RELAYED_SIGNAL_CODES.get(result.status);
  const reason =
    spawnFailure(result, label) ??
    (relayed ? `${label} exited ${result.status}, the code a wrapper relays for ${relayed} — the script itself was killed` : undefined);
  if (reason !== undefined) throw new IncompleteChildRun(reason, `${stdout}${stderr}`);
  return { status: result.status!, stdout, stderr };
}
