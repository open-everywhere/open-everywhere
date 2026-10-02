export type SetupRoute = "vercel" | "docker";

export const SETUP_ROUTES: readonly SetupRoute[] = ["vercel", "docker"];

export function isSetupRoute(value: string): value is SetupRoute {
  return (SETUP_ROUTES as readonly string[]).includes(value);
}

export interface StepContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly route?: SetupRoute;
  readonly host?: string;
  readonly appName?: string;
}

export function routeOf(ctx: StepContext): SetupRoute {
  return ctx.route ?? "vercel";
}

export interface StepCheckResult {
  readonly satisfied: boolean;
  readonly detail: string;
  readonly next?: string;
}

export interface StepGuide {
  readonly summary: string;
  readonly instructions: readonly string[];
}

export interface SetupStep {
  readonly id: string;
  readonly title: string;
  check(ctx: StepContext): Promise<StepCheckResult> | StepCheckResult;
  guide(ctx: StepContext): StepGuide;
}

export interface StepRunResult {
  readonly step: SetupStep;
  readonly check: StepCheckResult;
}

export interface SetupCheckSummary {
  readonly results: readonly StepRunResult[];
  readonly satisfiedCount: number;
  readonly total: number;
  readonly allSatisfied: boolean;
}

export async function checkAll(steps: readonly SetupStep[], ctx: StepContext): Promise<SetupCheckSummary> {
  const results: StepRunResult[] = [];
  for (const step of steps) {
    let check: StepCheckResult;
    try {
      check = await step.check(ctx);
    } catch (err) {
      check = { satisfied: false, detail: `check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    results.push({ step, check });
  }
  const satisfiedCount = results.filter((r) => r.check.satisfied).length;
  return { results, satisfiedCount, total: steps.length, allSatisfied: satisfiedCount === steps.length };
}
