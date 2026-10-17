import { resolveAppRoot } from "../agent/scaffold/app-root.js";
import { appEnv, gatherSovereigntyInput, registerAppSettings } from "../agent/ops/sovereignty-facts.js";
import { renderSovereigntyReport, sovereigntyReport } from "../agent/ops/sovereignty.js";

export interface SovereigntyIo {
  readonly out: (text: string) => void;
  readonly err: (line: string) => void;
}

export async function runSovereigntyCommand(args: readonly string[], io: SovereigntyIo, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  let host: "vercel" | "docker" | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--host" || a.startsWith("--host=")) {
      const v = a === "--host" ? args[++i] : a.slice("--host=".length);
      if (v !== "vercel" && v !== "docker") {
        io.err(`oe sovereignty: --host takes vercel or docker, got ${v === undefined ? "nothing" : `"${v}"`}.`);
        return 2;
      }
      host = v;
    } else {
      io.err(`oe sovereignty: unknown flag "${a}". Usage: oe sovereignty [--host vercel|docker] [--json]`);
      return 2;
    }
  }
  let appRoot: string;
  try {
    appRoot = resolveAppRoot({ cwd, env });
  } catch (err) {
    io.err(`✗ oe sovereignty: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const settingsProblem = await registerAppSettings(appRoot);
  if (settingsProblem !== undefined) {
    io.err(`✗ oe sovereignty: ${settingsProblem}. The report reads the app's own settings, so it prints nothing on the shipped defaults.`);
    return 1;
  }
  const report = sovereigntyReport(await gatherSovereigntyInput(appRoot, appEnv(appRoot, env), host));
  io.out(json ? `${JSON.stringify(report, null, 2)}\n` : renderSovereigntyReport(report));
  return 0;
}
