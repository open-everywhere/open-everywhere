import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, WizardIO, WizardStep } from "../engine.js";
import { isSet, mergedEnv, writeEnvLocal } from "../env-file.js";
import {
  RUNTIME_ROLE_NAME,
  OWNER_URL_ENV,
  generateRuntimePassword,
  deriveRuntimeUrl,
  twoRoleProvisioningSql,
} from "@open-everywhere/core/agent/ops/two-role.js";

function needsDb(env: Record<string, string | undefined>): boolean {
  const memProvider = env.OE_MEMORY_PROVIDER ?? "git";
  const opProvider = env.OE_OPERATIONAL_PROVIDER ?? "sqlite";
  return memProvider === "postgres" || opProvider === "postgres";
}

function targetsHostedDeploy(cwd: string): boolean {
  const p = join(cwd, ".vercel", "project.json");
  if (!existsSync(p)) return false;
  try {
    return Boolean((JSON.parse(readFileSync(p, "utf8")) as { projectId?: string }).projectId);
  } catch {
    return false;
  }
}

export const databaseStep: WizardStep = {
  id: "database",
  title: "Database (Neon/Postgres)",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env);
    if (!needsDb(env)) {
      if (targetsHostedDeploy(ctx.cwd)) {
        return {
          satisfied: false,
          detail: "git/sqlite backing on a Vercel-linked checkout — a hosted deploy discards memory and operational state",
        };
      }
      return { satisfied: true, detail: "local backing (git/sqlite) — no DB required" };
    }
    return { satisfied: isSet(env.DATABASE_URL), detail: isSet(env.DATABASE_URL) ? "DATABASE_URL set" : "DATABASE_URL missing (postgres backing selected)" };
  },
  guide(ctx: StepContext) {
    const hosted = targetsHostedDeploy(ctx.cwd);
    return {
      summary: hosted
        ? "This checkout is linked to a Vercel project, and Vercel's filesystem is ephemeral — the default git/sqlite backings are wiped on every deploy, so memory and operational state need Postgres."
        : "A hosted deploy needs Postgres (Vercel's filesystem is ephemeral, so git/sqlite backings don't persist).",
      instructions: [
        "Vercel dashboard → Storage → add Neon (Postgres) from the Marketplace — the connection string is injected automatically.",
        "Set OE_MEMORY_PROVIDER=postgres and OE_OPERATIONAL_PROVIDER=postgres.",
        hosted
          ? "Only ever running this locally? Unlink the Vercel project — while it's linked the wizard assumes you intend to deploy."
          : "Running purely locally? You can skip this — the default git/sqlite backings are fine.",
      ],
    };
  },
  async automate(ctx: StepContext, io: WizardIO) {
    const wantsHosted = await io.confirm("Set up hosted Postgres now? (say no if you're just running locally)");
    if (!wantsHosted) return { ran: false, ok: false, detail: "skipped — local git/sqlite backing" };
    const url = await io.askSecret("Paste your Neon/Postgres DATABASE_URL (the OWNER string — e.g. neondb_owner)");
    if (!url) return { ran: true, ok: false, detail: "no value entered" };

    const wantsTwoRole = await io.confirm(
      "Harden append-only with the two-role split? (recommended — the app runs as a non-owner role the owner-DDL escape can't reach)",
    );
    if (wantsTwoRole) {
      let runtimeUrl: string;
      const password = generateRuntimePassword();
      try {
        runtimeUrl = deriveRuntimeUrl(url, RUNTIME_ROLE_NAME, password);
      } catch (err) {
        writeEnvLocal(ctx.cwd, { DATABASE_URL: url, OE_MEMORY_PROVIDER: "postgres", OE_OPERATIONAL_PROVIDER: "postgres" });
        return { ran: true, ok: true, detail: `single-role (couldn't derive a runtime URL: ${err instanceof Error ? err.message : String(err)}). See docs/extending/database.md to adopt the split later.` };
      }
      io.print("");
      io.print("── Two-role provisioning ────────────────────────────────────────────────");
      io.print("1. Boot ONCE with the owner DATABASE_URL so the schema applies as the owner.");
      io.print(`2. Then run this SQL AS THE OWNER (creates the "${RUNTIME_ROLE_NAME}" role + its grants):`);
      io.print("");
      for (const stmt of twoRoleProvisioningSql(RUNTIME_ROLE_NAME, password)) io.print(`   ${stmt};`);
      io.print("");
      io.print(`   Generated runtime-role password (shown ONCE, not stored): ${password}`);
      io.print("   Re-run the GRANT statements after any upgrade that adds a table.");
      io.print("─────────────────────────────────────────────────────────────────────────");
      io.print("");
      writeEnvLocal(ctx.cwd, {
        DATABASE_URL: runtimeUrl,
        [OWNER_URL_ENV]: url,
        OE_MEMORY_PROVIDER: "postgres",
        OE_OPERATIONAL_PROVIDER: "postgres",
      });
      return { ran: true, ok: true, detail: `two-role: DATABASE_URL = the ${RUNTIME_ROLE_NAME} runtime role; owner parked as ${OWNER_URL_ENV} (both in .env.local, never a tracked file)` };
    }

    writeEnvLocal(ctx.cwd, { DATABASE_URL: url, OE_MEMORY_PROVIDER: "postgres", OE_OPERATIONAL_PROVIDER: "postgres" });
    return { ran: true, ok: true, detail: "single-role saved to .env.local (adopt the two-role split anytime — docs/extending/database.md)" };
  },
};
