import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);

const TSX_CLI = join(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");

function realEvePin(): string {
  const pkg = require("eve/package.json") as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("could not resolve the installed eve package's own version — is eve installed?");
  }
  return pkg.version;
}

if (process.env.OE_VERSION_SEAM_CHILD === "1") {
  const scratch = mkdtempSync(join(tmpdir(), "oe-version-seam-child-"));
  process.env.OE_PGLITE_DIR = join(scratch, "pglite");
  process.env.OE_MEMORY_DIR = join(scratch, "memory");
  delete process.env.DATABASE_URL;
  await import(pathToFileURL(join(process.cwd(), "agent", "agent.ts")).href);
  const { getAppInfo } = (await import("@open-everywhere/core/agent/commands/core.js")) as {
    getAppInfo: () => { deploymentSha: string; evePin: string };
  };
  console.log(`OE_VERSION_SEAM_RESULT:${JSON.stringify(getAppInfo())}`);
  process.exit(0);
}

const problems: string[] = [];

{
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  const scratch = mkdtempSync(join(tmpdir(), "oe-version-seam-"));
  process.env.OE_PGLITE_DIR = join(scratch, "pglite");
  process.env.OE_MEMORY_DIR = join(scratch, "memory");
  delete process.env.DATABASE_URL;

  await import(pathToFileURL(join(process.cwd(), "agent", "agent.ts")).href);
  const { getAppInfo } = (await import("@open-everywhere/core/agent/commands/core.js")) as {
    getAppInfo: () => { deploymentSha: string; evePin: string };
  };
  const info = getAppInfo();

  if (info.deploymentSha !== "unknown") {
    problems.push(
      `ARM A (negative control): with VERCEL_GIT_COMMIT_SHA unset, getAppInfo().deploymentSha ` +
        `must be "unknown" — got ${JSON.stringify(info.deploymentSha)}. A guessed or fabricated ` +
        `value here is exactly the fabrication class OPE-991 exists to close.`,
    );
  }
  const expectedEvePin = realEvePin();
  if (info.evePin !== expectedEvePin) {
    problems.push(
      `ARM A: getAppInfo().evePin should resolve the REAL installed eve version (${JSON.stringify(expectedEvePin)}) ` +
        `— got ${JSON.stringify(info.evePin)}. If this is "unknown", the read path never ran; if it is some ` +
        `other string, it drifted from the package that is actually installed.`,
    );
  }
}

{
  const fakeSha = "deadbeef1234567890abcdef1234567890abcdef";
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url)], {
      env: { ...process.env, OE_VERSION_SEAM_CHILD: "1", VERCEL_GIT_COMMIT_SHA: fakeSha },
      encoding: "utf8",
      cwd: process.cwd(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`ARM B: the child boot process threw — ${message.split("\n")[0]}`);
    stdout = "";
  }
  if (stdout) {
    const lines = stdout.split("\n").filter((l) => l.startsWith("OE_VERSION_SEAM_RESULT:"));
    const last = lines.at(-1);
    if (!last) {
      problems.push(`ARM B: the child process produced no OE_VERSION_SEAM_RESULT line — full stdout:\n${stdout}`);
    } else {
      const info = JSON.parse(last.slice("OE_VERSION_SEAM_RESULT:".length)) as { deploymentSha: string; evePin: string };
      if (info.deploymentSha !== fakeSha) {
        problems.push(
          `ARM B (positive): with VERCEL_GIT_COMMIT_SHA=${JSON.stringify(fakeSha)}, getAppInfo().deploymentSha ` +
            `must echo it back exactly — got ${JSON.stringify(info.deploymentSha)}.`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ agent-version-seam: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("✓ agent-version-seam: deploymentSha reads \"unknown\" off-platform and echoes the platform sha exactly when present; evePin resolves the real installed eve version");
