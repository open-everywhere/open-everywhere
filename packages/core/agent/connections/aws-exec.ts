import type { AwsCredentials } from "./aws-identity.js";

export interface AwsExecRequest {
  readonly credentials: AwsCredentials;
  readonly region?: string;
  readonly args: readonly string[];
}

export interface AwsExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AwsExecutor {
  run(req: AwsExecRequest): Promise<AwsExecResult>;
}

let registered: AwsExecutor | undefined;

export function registerAwsExecutor(executor: AwsExecutor): void {
  registered = executor;
}

export function resetAwsExecutor(): void {
  registered = undefined;
}

export function awsExecutor(): AwsExecutor | undefined {
  return registered;
}

export function requireAwsExecutor(): AwsExecutor {
  if (!registered) {
    throw new Error(
      "no AWS executor is registered — the AWS adapter (packages/adapters/agent/aws) is not wired. " +
        "Register it at boot (register-adapters.ts). Fail-closed: no AWS access.",
    );
  }
  return registered;
}
