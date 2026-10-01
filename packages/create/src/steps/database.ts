import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { goalOf, type StepContext, type WizardIO, type WizardStep } from "../engine.js";
import { HOSTED_MISS_NOTE, isSet, mergedEnv, writeEnvLocal } from "../env-file.js";
import {
  RUNTIME_ROLE_NAME,
  OWNER_URL_ENV,
  generateRuntimePassword,
  deriveRuntimeUrl,
  twoRoleProvisioningSql,
} from "@open-everywhere/core/agent/ops/two-role.js";

const HOSTED_SELECTORS = ["OE_OPERATIONAL_PROVIDER", "OE_MEMORY_PROVIDER"] as const;

const HOSTED_DB_NEXT =
  "add Neon from the Vercel Marketplace (Vercel project → Storage → Neon → Connect; it sets DATABASE_URL on the project), then run `npx create-open-everywhere` in a terminal to paste the same DATABASE_URL into .env.local, or set DATABASE_URL, OE_OPERATIONAL_PROVIDER=postgres and OE_MEMORY_PROVIDER=postgres there yourself";

function targetsHostedDeploy(cwd: string): boolean {
  const p = join(cwd, ".vercel", "project.json");
  if (!existsSync(p)) return false;
  try {
    return Boolean((JSON.parse(readFileSync(p, "utf8")) as { projectId?: string }).projectId);
  } catch {
    return false;
  }
}

function hostedJudged(ctx: StepContext): boolean {
  return goalOf(ctx) === "hosted" || targetsHostedDeploy(ctx.cwd);
}

export const databaseStep: WizardStep = {
  id: "database",
  title: "Database (Neon/Postgres)",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env);
    if (hostedJudged(ctx)) {
      const missing = [
        ...(isSet(env.DATABASE_URL) ? [] : ["DATABASE_URL"]),
        ...HOSTED_SELECTORS.filter((k) => env[k]?.trim() !== "postgres").map((k) => `${k}=postgres`),
      ];
      if (missing.length === 0) {
        return {
          satisfied: true,
          detail: "DATABASE_URL and both postgres selectors are set locally. This check cannot read the Vercel project: the Neon integration sets DATABASE_URL there, and the two selectors must be set for Production too",
        };
      }
      return {
        satisfied: false,
        detail: `a hosted deploy needs Postgres (Vercel discards local state). Missing from .env.local and this shell: ${missing.join(", ")}. ${HOSTED_MISS_NOTE}`,
        next: HOSTED_DB_NEXT,
      };
    }
    const postgresSelected = env.OE_MEMORY_PROVIDER === "postgres" || env.OE_OPERATIONAL_PROVIDER?.trim() === "postgres";
    if (postgresSelected && !isSet(env.DATABASE_URL)) {
      return { satisfied: false, detail: "a postgres store is selected, but DATABASE_URL is missing", next: "set DATABASE_URL in .env.local, or unset the postgres selectors for the embedded floor" };
    }
    return {
      satisfied: true,
      detail: postgresSelected ? "DATABASE_URL set (postgres selected)" : "local run: the embedded Postgres floor under .open-everywhere-data/ — no database to set up",
    };
  },
  guide(ctx: StepContext) {
    const hosted = hostedJudged(ctx);
    return {
      summary: hosted
        ? "A hosted deploy needs Postgres: Vercel's filesystem is ephemeral, so local stores are wiped on every deploy, and core throws on them there at first use."
        : "A local run uses the embedded Postgres floor and needs no database.",
      instructions: [
        "Vercel project → Storage → Neon → Connect. The Marketplace integration sets DATABASE_URL on the project.",
        "Copy the same DATABASE_URL into .env.local (this step can do it), with OE_MEMORY_PROVIDER=postgres and OE_OPERATIONAL_PROVIDER=postgres.",
        hosted
          ? "Only ever running locally? Re-run with `--goal local`, and unlink the Vercel project if one is linked."
          : "To deploy, re-run without `--goal local`.",
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
