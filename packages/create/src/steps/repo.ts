import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AutomateResult, StepContext, WizardIO, WizardStep } from "../engine.js";
import { npmCommand } from "../npm.js";

interface AppState {
  readonly ok: boolean;
  readonly app: boolean;
  readonly detail: string;
}

function inspectApp(cwd: string): AppState {
  const pkgPath = join(cwd, "package.json");
  const agentEntry = join(cwd, "agent", "agent.ts");
  if (!existsSync(pkgPath)) return { ok: false, app: false, detail: "no package.json here — not an Open Everywhere app" };
  if (!existsSync(agentEntry)) {
    return { ok: false, app: false, detail: "no agent/agent.ts here — not an Open Everywhere app (eve finds the agent graph by convention)" };
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      workspaces?: string[];
    };
    const hasCoreDep = Boolean(pkg.dependencies?.["@open-everywhere/core"] ?? pkg.devDependencies?.["@open-everywhere/core"]);
    const hasWorkspaces = Array.isArray(pkg.workspaces) && pkg.workspaces.some((w) => w.includes("packages"));
    if (!hasCoreDep && !hasWorkspaces) return { ok: false, app: false, detail: "package.json here doesn't reach @open-everywhere/core" };
  } catch {
    return { ok: false, app: false, detail: "package.json here is unreadable" };
  }
  const installed = existsSync(join(cwd, "node_modules"));
  return { ok: installed, app: true, detail: installed ? "app found, deps installed" : "app found, but run `npm install`" };
}

export const repoStep: WizardStep = {
  id: "repo",
  title: "Repo (app + install)",
  check(ctx: StepContext) {
    const { ok, app, detail } = inspectApp(ctx.cwd);
    return { satisfied: ok, detail, next: ok ? undefined : app ? "npm install" : "npx create-open-everywhere my-agent && cd my-agent" };
  },
  guide() {
    return {
      summary: "Get an Open Everywhere app with deps installed.",
      instructions: [
        "Easiest: `npx create-open-everywhere my-agent` scaffolds the quickstart app into ./my-agent and runs this wizard there.",
        "Or clone the repository: `git clone https://github.com/open-everywhere/open-everywhere && cd open-everywhere && npm install`.",
        "Then re-run this wizard FROM inside that app.",
      ],
    };
  },
  async automate(ctx: StepContext, io: WizardIO): Promise<AutomateResult> {
    const state = inspectApp(ctx.cwd);
    if (!state.app) return { ran: false, ok: false, detail: state.detail };
    if (state.ok) return { ran: false, ok: true, detail: "nothing to install" };
    if (!(await io.confirm("Run `npm install` now? Its postinstall applies the eve patch."))) {
      return { ran: false, ok: false, detail: "skipped — run `npm install` yourself" };
    }
    const [command, args] = npmCommand(["install"], ctx.env);
    const result = spawnSync(command, args, { cwd: ctx.cwd, stdio: "inherit", env: ctx.env });
    const ok = result.status === 0;
    return { ran: true, ok, detail: ok ? "deps installed" : `npm install failed (exit ${result.status ?? "unknown"})` };
  },
};
