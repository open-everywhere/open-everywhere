import { preflight } from "@open-everywhere/core/agent/ops/quickstart.js";
import { goalOf, type StepContext, type WizardStep } from "../engine.js";
import { HOSTED_MISS_NOTE, mergedEnv } from "../env-file.js";

export const envChecklistStep: WizardStep = {
  id: "env-checklist",
  title: "Env var checklist",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env) as NodeJS.ProcessEnv;
    const { checks, ready } = preflight(env, { target: goalOf(ctx) });
    const missing = checks.filter((c) => c.status === "missing");
    return {
      satisfied: ready,
      detail: ready
        ? `all required env vars present for a ${goalOf(ctx)} run`
        : goalOf(ctx) === "hosted"
          ? `missing from .env.local and this shell: ${missing.map((c) => c.name).join(", ")}. ${HOSTED_MISS_NOTE}`
          : `missing: ${missing.map((c) => c.name).join(", ")}`,
      next: ready ? undefined : missing.map((c) => c.fix).filter((f): f is string => Boolean(f)).join(" · "),
    };
  },
  guide(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env) as NodeJS.ProcessEnv;
    const { checks } = preflight(env, { target: goalOf(ctx) });
    const lines = checks.map((c) => `${c.name}: ${c.status}${c.fix ? ` — ${c.fix}` : ""}`);
    return {
      summary: "Presence-only checklist (never prints a value) — see the configuration reference for the full surface: https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/configuration-reference.md",
      instructions: lines,
    };
  },
};
