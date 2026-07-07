import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, WizardStep } from "../engine.js";

export const vercelStep: WizardStep = {
  id: "vercel",
  title: "Vercel project link",
  check(ctx: StepContext) {
    const p = join(ctx.cwd, ".vercel", "project.json");
    if (!existsSync(p)) return { satisfied: false, detail: "no .vercel/project.json — not linked yet" };
    try {
      const linked = JSON.parse(readFileSync(p, "utf8")) as { projectId?: string };
      return { satisfied: Boolean(linked.projectId), detail: linked.projectId ? "linked to a Vercel project" : ".vercel/project.json is malformed" };
    } catch {
      return { satisfied: false, detail: ".vercel/project.json is unreadable" };
    }
  },
  guide() {
    return {
      summary: "Link this checkout to a Vercel project (needed for `vercel deploy` and OIDC model auth).",
      instructions: [
        "`npx vercel link` — follow the prompts (device auth in your browser).",
        "Or use the Deploy-to-Vercel button, which creates and links the project for you.",
      ],
    };
  },
};
