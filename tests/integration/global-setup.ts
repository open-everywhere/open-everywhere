import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export default function globalSetup(): void {
  const root = process.cwd();
  if (process.env.OE_IT_SKIP_BUILD === "1") {
    if (!existsSync(join(root, ".output", "server", "index.mjs"))) {
      throw new Error("OE_IT_SKIP_BUILD=1 but .output/server/index.mjs does not exist — run the build first.");
    }
    return;
  }
  execFileSync("npm", ["run", "oe:build"], { cwd: root, stdio: "inherit" });
  execFileSync("npx", ["eve", "build"], { cwd: root, stdio: "inherit" });
}
