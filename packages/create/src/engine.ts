export interface StepContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface StepCheckResult {
  readonly satisfied: boolean;
  readonly detail: string;
}

export interface StepGuide {
  readonly summary: string;
  readonly instructions: readonly string[];
}

export interface AutomateResult {
  readonly ran: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

export interface WizardIO {
  print(line: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

export interface WizardStep {
  readonly id: string;
  readonly title: string;
  check(ctx: StepContext): Promise<StepCheckResult> | StepCheckResult;
  guide(ctx: StepContext): StepGuide;
  automate?(ctx: StepContext, io: WizardIO): Promise<AutomateResult>;
}

export type StepOutcome = "satisfied" | "automated" | "guided" | "declined";

export interface StepRunResult {
  readonly step: WizardStep;
  readonly outcome: StepOutcome;
  readonly check: StepCheckResult;
  readonly automate?: AutomateResult;
}

export interface WizardRunSummary {
  readonly results: readonly StepRunResult[];
  readonly satisfiedCount: number;
  readonly total: number;
  readonly allSatisfied: boolean;
}

export async function checkAll(steps: readonly WizardStep[], ctx: StepContext): Promise<WizardRunSummary> {
  const results: StepRunResult[] = [];
  for (const step of steps) {
    const check = await step.check(ctx);
    results.push({ step, outcome: check.satisfied ? "satisfied" : "guided", check });
  }
  const satisfiedCount = results.filter((r) => r.check.satisfied).length;
  return { results, satisfiedCount, total: steps.length, allSatisfied: satisfiedCount === steps.length };
}

export async function runWizard(steps: readonly WizardStep[], ctx: StepContext, io: WizardIO): Promise<WizardRunSummary> {
  const results: StepRunResult[] = [];
  for (const step of steps) {
    io.print("");
    io.print(`— ${step.title} —`);
    let check: StepCheckResult;
    try {
      check = await step.check(ctx);
    } catch (err) {
      check = { satisfied: false, detail: `check failed: ${errMessage(err)}` };
    }

    if (check.satisfied) {
      io.print(`✓ ${check.detail}`);
      results.push({ step, outcome: "satisfied", check });
      continue;
    }

    const guide = step.guide(ctx);
    io.print(guide.summary);
    for (const line of guide.instructions) io.print(`  - ${line}`);

    if (!step.automate) {
      io.print(`(not satisfied: ${check.detail})`);
      results.push({ step, outcome: "guided", check });
      continue;
    }

    let automate: AutomateResult;
    try {
      automate = await step.automate(ctx, io);
    } catch (err) {
      automate = { ran: false, ok: false, detail: `automation failed: ${errMessage(err)}` };
    }

    let recheck = check;
    if (automate.ran) {
      try {
        recheck = await step.check(ctx);
      } catch (err) {
        recheck = { satisfied: false, detail: `check failed: ${errMessage(err)}` };
      }
    }
    const outcome: StepOutcome = automate.ran ? (recheck.satisfied ? "automated" : "guided") : "declined";
    results.push({ step, outcome, check: recheck, automate });
  }

  const satisfiedCount = results.filter((r) => r.check.satisfied).length;
  return { results, satisfiedCount, total: steps.length, allSatisfied: satisfiedCount === steps.length };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
