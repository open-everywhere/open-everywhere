import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { routeOf, type SetupStep, type StepContext } from "../engine.js";

export const vercelStep: SetupStep = {
  id: "vercel",
  title: "Vercel project link",
  check(ctx: StepContext) {
    if (routeOf(ctx) === "docker") return { satisfied: true, detail: "not needed on the Docker route (--route docker)" };
    const p = join(ctx.cwd, ".vercel", "project.json");
    if (!existsSync(p)) return { satisfied: false, detail: "no .vercel/project.json — not linked yet", next: "npx vercel link" };
    try {
      const linked = JSON.parse(readFileSync(p, "utf8")) as { projectId?: string };
      return linked.projectId
        ? { satisfied: true, detail: "linked to a Vercel project" }
        : { satisfied: false, detail: ".vercel/project.json is malformed", next: "npx vercel link" };
    } catch {
      return { satisfied: false, detail: ".vercel/project.json is unreadable", next: "npx vercel link" };
    }
  },
  guide(ctx: StepContext) {
    if (routeOf(ctx) === "docker") {
      return {
        summary: "The Docker route needs no Vercel project.",
        instructions: ["Nothing to do: `--route docker` skips this step. The deployment contract is the Docker route's reference."],
      };
    }
    return {
      summary: "Link this app to a Vercel project. Every later `vercel` command acts on the linked project.",
      instructions: ["`npx vercel link` — follow the prompts (device auth in your browser)."],
    };
  },
};
