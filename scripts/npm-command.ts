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
