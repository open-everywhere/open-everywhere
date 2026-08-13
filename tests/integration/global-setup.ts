import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default async function globalSetup(): Promise<void> {
  const root = process.cwd();
  const templateDir = join(root, ".eve", "sandbox-cache", "just-bash", "templates");
  if (process.env.OE_IT_SKIP_BUILD === "1") {
    if (!existsSync(join(root, ".output", "server", "index.mjs"))) {
      throw new Error("OE_IT_SKIP_BUILD=1 but .output/server/index.mjs does not exist — run the build first.");
    }
    if (!existsSync(templateDir)) {
      throw new Error(
        "OE_IT_SKIP_BUILD=1 but .eve/sandbox-cache/just-bash/templates does not exist — the just-bash " +
          "sandbox template was never prewarmed on this tree and every turn would die on " +
          "SandboxTemplateNotProvisionedError. Run `npm run test:integration` once without the flag.",
      );
    }
    return;
  }
  execFileSync("npm", ["run", "oe:build"], { cwd: root, stdio: "inherit" });
  execFileSync("npx", ["eve", "build"], { cwd: root, stdio: "inherit" });
  await prewarmJustBashTemplate(root);
}

async function prewarmJustBashTemplate(root: string): Promise<void> {
  process.env.OE_SANDBOX_BACKEND = "justbash";
  const state = mkdtempSync(join(tmpdir(), "oe-it-prewarm-"));
  process.env.OE_PGLITE_DIR ??= join(state, "pglite");
  process.env.OE_MEMORY_DIR ??= join(state, "memory");
  delete process.env.NODE_ENV;

  const prewarmPath = join(root, "node_modules", "eve", "dist", "src", "execution", "sandbox", "prewarm.js");
  let mod: { prewarmBuiltAppSandboxes?: (input: { appRoot: string; log?: (m: string) => void }) => Promise<void> };
  try {
    mod = (await import(pathToFileURL(prewarmPath).href)) as typeof mod;
  } catch (err) {
    throw new Error(
      `integration global-setup: eve's sandbox prewarm module is gone from ${prewarmPath} — an eve bump moved it. ` +
        "Find the new home of prewarmBuiltAppSandboxes under eve/dist and update tests/integration/global-setup.ts " +
        "(and the eve-upgrade-check skill's checklist).",
      { cause: err },
    );
  }
  if (typeof mod.prewarmBuiltAppSandboxes !== "function") {
    throw new Error(
      `integration global-setup: ${prewarmPath} no longer exports prewarmBuiltAppSandboxes — an eve bump renamed it. ` +
        "Update tests/integration/global-setup.ts to the new export.",
    );
  }
  await mod.prewarmBuiltAppSandboxes({ appRoot: root, log: (m) => console.log(m) });
  if (!existsSync(join(root, ".eve", "sandbox-cache", "just-bash", "templates"))) {
    throw new Error(
      "integration global-setup: prewarm completed but .eve/sandbox-cache/just-bash/templates is still absent — " +
        "the backend selection did not land on just-bash. Check OE_SANDBOX_BACKEND handling above.",
    );
  }
}
