import { isSet, mergedEnv, missNote } from "../env-file.js";
import { routeOf, type SetupRoute, type SetupStep, type StepContext } from "../engine.js";
import { resolveOperationalSelection } from "@open-everywhere/core/agent/operational/selection.js";
import { resolveMemoryProviderId } from "@open-everywhere/core/agent/memory/backing-selection.js";
import { OWNER_URL_ENV, RUNTIME_ROLE_NAME } from "@open-everywhere/core/agent/ops/two-role.js";

function postgresResolution(env: NodeJS.ProcessEnv): { operational: boolean; memory: boolean } {
  const op = resolveOperationalSelection(env);
  return { operational: op.id === "postgres" && op.floor === "none", memory: resolveMemoryProviderId(env) === "postgres" };
}

function nextFor(route: SetupRoute): string {
  const write = 'write it with the ops MCP tool `scaffold_env { values: { DATABASE_URL: "<the connection string>" } }` — it selects postgres for both stores on its own';
  return route === "vercel"
    ? `add Neon from the Vercel Marketplace (\`npx vercel install neon\`, or the project's Storage → Neon → Connect; either sets DATABASE_URL on the project), then ${write}`
    : `provision a Postgres the container can reach (the deployment contract names it), then ${write}`;
}

export const databaseStep: SetupStep = {
  id: "database",
  title: "Database (Postgres)",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env) as NodeJS.ProcessEnv;
    const route = routeOf(ctx);
    const resolved = postgresResolution(env);
    if (isSet(env.DATABASE_URL) && resolved.operational && resolved.memory) {
      return {
        satisfied: true,
        detail:
          "DATABASE_URL is set locally and selects postgres for both stores. This check cannot read the deployment's own " +
          "environment: the same connection string must reach it too",
      };
    }
    const pointedAway = [
      ...(resolved.operational || !isSet(env.OE_OPERATIONAL_PROVIDER) ? [] : ["OE_OPERATIONAL_PROVIDER"]),
      ...(resolved.memory || !isSet(env.OE_MEMORY_PROVIDER) ? [] : ["OE_MEMORY_PROVIDER"]),
    ];
    return {
      satisfied: false,
      detail:
        "a deployment needs Postgres on both routes. " +
        (isSet(env.DATABASE_URL)
          ? `DATABASE_URL is set, but a selector points away from postgres: ${pointedAway.join(", ")}. Remove it, or set it to postgres. `
          : "Missing from .env.local and this shell: DATABASE_URL — it selects postgres for both stores on its own. ") +
        missNote(route),
      next: nextFor(route),
    };
  },
  guide(ctx: StepContext) {
    const vercel = routeOf(ctx) === "vercel";
    return {
      summary: "Both routes need Postgres: an ephemeral disk (Vercel) or a replaced container (Docker) loses every local store.",
      instructions: [
        vercel
          ? "`npx vercel install neon` provisions Neon and connects it to the linked project, which sets DATABASE_URL there. The project's Storage → Neon → Connect does the same thing."
          : "Provision a Postgres the container can reach (Neon, RDS, or your own server). The deployment contract states what it must satisfy.",
        "Write the same connection string into .env.local with the ops tool `scaffold_env`. It selects postgres for the operational store and the memory backing on its own — no provider selector needed. Never paste a connection string into the chat.",
        vercel
          ? "The deployment needs it too: the Neon integration already set DATABASE_URL on the Vercel project."
          : "The deployment needs it too: DATABASE_URL is part of the container's environment.",
        `Harden later: the two-role split parks the owner credential as ${OWNER_URL_ENV} and runs the app as the non-owner "${RUNTIME_ROLE_NAME}" role, which the owner-DDL escape cannot reach. It is MANUAL — nothing provisions it for you. See https://github.com/open-everywhere/open-everywhere/blob/main/docs/extending/database.md.`,
      ],
    };
  },
};
