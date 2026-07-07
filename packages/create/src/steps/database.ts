import type { StepContext, WizardIO, WizardStep } from "../engine.js";
import { isSet, mergedEnv, writeEnvLocal } from "../env-file.js";

function needsDb(env: Record<string, string | undefined>): boolean {
  const memProvider = env.OE_MEMORY_PROVIDER ?? "git";
  const opProvider = env.OE_OPERATIONAL_PROVIDER ?? "sqlite";
  return memProvider === "postgres" || opProvider === "postgres";
}

export const databaseStep: WizardStep = {
  id: "database",
  title: "Database (Neon/Postgres)",
  check(ctx: StepContext) {
    const env = mergedEnv(ctx.cwd, ctx.env);
    if (!needsDb(env)) return { satisfied: true, detail: "local backing (git/sqlite) — no DB required" };
    return { satisfied: isSet(env.DATABASE_URL), detail: isSet(env.DATABASE_URL) ? "DATABASE_URL set" : "DATABASE_URL missing (postgres backing selected)" };
  },
  guide() {
    return {
      summary: "A hosted deploy needs Postgres (Vercel's filesystem is ephemeral, so git/sqlite backings don't persist).",
      instructions: [
        "Vercel dashboard → Storage → add Neon (Postgres) from the Marketplace — the connection string is injected automatically.",
        "Set OE_MEMORY_PROVIDER=postgres and OE_OPERATIONAL_PROVIDER=postgres.",
        "Running purely locally? You can skip this — the default git/sqlite backings are fine.",
      ],
    };
  },
  async automate(ctx: StepContext, io: WizardIO) {
    const wantsHosted = await io.confirm("Set up hosted Postgres now? (say no if you're just running locally)");
    if (!wantsHosted) return { ran: false, ok: false, detail: "skipped — local git/sqlite backing" };
    const url = await io.askSecret("Paste your Neon/Postgres DATABASE_URL");
    if (!url) return { ran: true, ok: false, detail: "no value entered" };
    writeEnvLocal(ctx.cwd, {
      DATABASE_URL: url,
      OE_MEMORY_PROVIDER: "postgres",
      OE_OPERATIONAL_PROVIDER: "postgres",
    });
    return { ran: true, ok: true, detail: "saved to .env.local (value not shown here or ever logged)" };
  },
};
