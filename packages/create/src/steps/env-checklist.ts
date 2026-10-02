import { preflight } from "@open-everywhere/core/agent/ops/quickstart.js";
import { routeOf, type SetupStep, type StepContext } from "../engine.js";
import { mergedEnv, missNote } from "../env-file.js";

export const envChecklistStep: SetupStep = {
  id: "env-checklist",
  title: "Env var checklist",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env) as NodeJS.ProcessEnv;
    const route = routeOf(ctx);
    const { checks, ready } = preflight(env, { target: route });
    const missing = checks.filter((c) => c.status === "missing");
    return {
      satisfied: ready,
      detail: ready
        ? `all required env vars present for the ${route} route`
        : `missing from .env.local and this shell: ${missing.map((c) => c.name).join(", ")}. ${missNote(route)}`,
      next: ready ? undefined : missing.map((c) => c.fix).filter((f): f is string => Boolean(f)).join(" · "),
    };
  },
  guide(ctx: StepContext) {
    const route = routeOf(ctx);
    return {
      summary:
        "A presence-only checklist (it never prints a value). The full surface is in the configuration reference: " +
        "https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/configuration-reference.md",
      instructions: [
        "Both routes need two values: DATABASE_URL and OE_CREDENTIAL_ENCRYPTION_KEY. DATABASE_URL resolves BOTH stores to postgres on its own (OPE-2230), so there is no provider selector to set — a selector pointing away from postgres is the only thing that breaks it.",
        "Mint OE_CREDENTIAL_ENCRYPTION_KEY with the ops tool `scaffold_credential_key`: it writes a base64 32-byte AES-256 key into .env.local and never prints it. The encrypted credential store fails closed on every read and write without it.",
        route === "docker"
          ? "The Docker route also needs a model route: AI_GATEWAY_API_KEY. There is no OIDC off Vercel. Running a different model backend is an adapter swap in app code, not an env setting — https://github.com/open-everywhere/open-everywhere/blob/main/docs/extending/adapter-model.md."
          : "The Vercel route needs NO AI_GATEWAY_API_KEY: a deployed project authenticates to the AI Gateway with OIDC.",
        "Each chat surface adds its own names — Slack reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from the environment.",
        "Not needed on a deployment: OE_PUBLIC_BASE_URL (only for a custom domain) and OE_INTAKE_PAGE_SIGNING_KEY (the deployment mints it into the credential store).",
        "Run `npx @open-everywhere/create --check --json`, or the ops tool `preflight`, for the live verdict per name.",
      ],
    };
  },
};
