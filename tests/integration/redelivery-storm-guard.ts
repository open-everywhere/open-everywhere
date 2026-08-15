export const REDELIVERY_SIGNATURE = "Re-executing inline steps owned by this queue message";

export const REDELIVERY_STORM_THRESHOLD = 40;

const RUN_LINE = /^\s*run\s+(\S+)/m;
const STEP_IDS_LINE = /^\s*stepIds\s+(\[[^\]]*\])/m;

export interface RedeliveryStormVerdict {
  readonly count: number;
  readonly runId?: string;
  readonly stepIds?: string;
}

export class RedeliveryStormGuard {
  private count = 0;
  private lastRunId: string | undefined;
  private lastStepIds: string | undefined;

  constructor(private readonly threshold: number = REDELIVERY_STORM_THRESHOLD) {}

  observe(text: string): void {
    if (!text.includes(REDELIVERY_SIGNATURE)) return;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(REDELIVERY_SIGNATURE, from);
      if (idx === -1) break;
      this.count++;
      from = idx + REDELIVERY_SIGNATURE.length;
    }
    const runMatch = RUN_LINE.exec(text);
    if (runMatch) this.lastRunId = runMatch[1];
    const stepMatch = STEP_IDS_LINE.exec(text);
    if (stepMatch) this.lastStepIds = stepMatch[1];
  }

  tripped(): RedeliveryStormVerdict | undefined {
    if (this.count < this.threshold) return undefined;
    return { count: this.count, runId: this.lastRunId, stepIds: this.lastStepIds };
  }

  reset(): void {
    this.count = 0;
    this.lastRunId = undefined;
    this.lastStepIds = undefined;
  }
}
