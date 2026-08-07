import { execFile } from "node:child_process";
import type { AwsCredentials, AwsExecRequest, AwsExecResult, AwsExecutor } from "@open-everywhere/core/agent/adapter-api.js";

export interface AwsExecInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export type AwsRunner = (inv: AwsExecInvocation) => Promise<AwsExecResult>;

export interface AwsCliExecutorOptions {
  readonly run?: AwsRunner;
  readonly binary?: string;
  readonly defaultRegion?: string;
}

const defaultRunner: AwsRunner = (inv) =>
  new Promise<AwsExecResult>((resolve, reject) => {
    execFile(inv.file, [...inv.args], { env: inv.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") {
          resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        reject(err);
        return;
      }
      resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const CHILD_ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

function childEnv(credentials: AwsCredentials, region: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_PASSTHROUGH) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("LC_")) env[k] = process.env[k];
  }
  env.AWS_CONFIG_FILE = "/dev/null";
  env.AWS_SHARED_CREDENTIALS_FILE = "/dev/null";
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
  env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
  env.AWS_SESSION_TOKEN = credentials.sessionToken;
  if (region) {
    env.AWS_REGION = region;
    env.AWS_DEFAULT_REGION = region;
  }
  return env;
}

export function makeAwsCliExecutor(opts: AwsCliExecutorOptions = {}): AwsExecutor {
  const runner = opts.run ?? defaultRunner;
  const binary = opts.binary ?? "aws";
  const defaultRegion = opts.defaultRegion;

  return {
    async run(req: AwsExecRequest): Promise<AwsExecResult> {
      const inv: AwsExecInvocation = {
        file: binary,
        args: req.args,
        env: childEnv(req.credentials, req.region ?? defaultRegion),
      };
      try {
        return await runner(inv);
      } catch (err) {
        throw new Error(
          `failed to launch the AWS CLI ("${binary}") — is it installed and on PATH? ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}
