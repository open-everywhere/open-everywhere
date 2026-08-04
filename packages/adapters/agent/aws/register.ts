import {
  registerAwsIdentityProvider,
  registerAwsExecutor,
  type AwsIdentityProvider,
  type AwsExecutor,
} from "@open-everywhere/core/agent/adapter-api.js";
import { makeAwsStsProvider, type AwsStsProviderOptions } from "./sts.js";
import { makeAwsCliExecutor, type AwsCliExecutorOptions } from "./cli.js";
import { loadAwsAccessConfig } from "./config.js";

export interface RegisterAwsAccessOptions {
  readonly identity?: AwsStsProviderOptions;
  readonly executor?: AwsCliExecutorOptions;
}

export function registerAwsAccess(opts: RegisterAwsAccessOptions = {}): {
  provider: AwsIdentityProvider;
  executor: AwsExecutor;
} {
  const { defaultRegion } = loadAwsAccessConfig();
  const provider = makeAwsStsProvider({ defaultRegion, ...opts.identity });
  const executor = makeAwsCliExecutor({ defaultRegion, ...opts.executor });
  registerAwsIdentityProvider(provider);
  registerAwsExecutor(executor);
  return { provider, executor };
}
