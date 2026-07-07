import { preflight } from "@open-everywhere/core/agent/ops/quickstart.js";
import type { StepContext, WizardStep } from "../engine.js";
import { mergedEnv } from "../env-file.js";

export const envChecklistStep: WizardStep = {
  id: "env-checklist",
  title: "Env var checklist",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env) as NodeJS.ProcessEnv;
    const { checks, ready } = preflight(env);
    const missing = checks.filter((c) => c.status === "missing").map((c) => c.name);
    return { satisfied: ready, detail: ready ? "all required env vars present" : `missing: ${missing.join(", ")}` };
  },
  guide(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env) as NodeJS.ProcessEnv;
    const { checks } = preflight(env);
    const lines = checks.map((c) => `${c.name}: ${c.status}${c.fix ? ` — ${c.fix}` : ""}`);
    return {
      summary: "Presence-only checklist (never prints a value) — see docs/deploy/configuration-reference.md for the full surface.",
      instructions: lines,
    };
  },
};
