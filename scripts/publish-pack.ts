import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { npmCommand } from "./npm-command.js";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";

export interface PackedPackage {
  readonly name: string;
  readonly tarball: string;
}

export function packPublishablePackages(repoRoot: string, destDir: string): PackedPackage[] {
  mkdirSync(destDir, { recursive: true });
  return ALL_PUBLISHABLE_PACKAGES.map((pkgDir) => {
    const { name } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name: string };
    const [cmd, args] = npmCommand(["pack", "--workspace", name, "--pack-destination", destDir, "--loglevel", "error", "--ignore-scripts"]);
    let out: string;
    try {
      out = execFileSync(cmd, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`npm pack ${name} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    const file = out.trim().split("\n").pop()?.trim() ?? "";
    if (!file.endsWith(".tgz")) throw new Error(`npm pack ${name} printed no tarball name:\n${out}`);
    return { name, tarball: join(destDir, file) };
  });
}
