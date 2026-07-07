import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, WizardStep } from "../engine.js";

function looksLikeOpenEverywhereCheckout(cwd: string): { ok: boolean; detail: string } {
  const agentsMd = join(cwd, "AGENTS.md");
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(agentsMd) || !existsSync(pkgPath)) {
    return { ok: false, detail: "not an Open Everywhere checkout (no AGENTS.md/package.json here)" };
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; workspaces?: string[] };
    const hasCoreDep = Boolean(pkg.dependencies?.["@open-everywhere/core"]);
    const hasWorkspaces = Array.isArray(pkg.workspaces) && pkg.workspaces.some((w) => w.includes("packages"));
    if (!hasCoreDep && !hasWorkspaces) return { ok: false, detail: "package.json here doesn't look like Open Everywhere" };
  } catch {
    return { ok: false, detail: "package.json here is unreadable" };
  }
  const installed = existsSync(join(cwd, "node_modules"));
  return { ok: installed, detail: installed ? "checkout found, deps installed" : "checkout found, but run `npm install`" };
}

export const repoStep: WizardStep = {
  id: "repo",
  title: "Repo (clone + install)",
  check(ctx: StepContext) {
    const { ok, detail } = looksLikeOpenEverywhereCheckout(ctx.cwd);
    return { satisfied: ok, detail };
  },
  guide() {
    return {
      summary: "Get an Open Everywhere checkout with deps installed.",
      instructions: [
        "Easiest: click the Deploy-to-Vercel button in the README/docs (clones to your GitHub + creates a Vercel project).",
        "Or: `git clone https://github.com/open-everywhere/open-everywhere && cd open-everywhere && npm install`.",
        "Then re-run this wizard FROM inside that checkout.",
      ],
    };
  },
};
