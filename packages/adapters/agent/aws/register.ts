import {
  registerAwsIdentityProvider,
  registerAwsExecutor,
  registerAwsSsoLinkStore,
  registerAwsSsoCallbackCompleter,
  registerCredentialPurgeHook,
  type AwsIdentityProvider,
  type AwsExecutor,
} from "@open-everywhere/core/agent/adapter-api.js";
import { makeAwsStsProvider, type AwsStsProviderOptions } from "./sts.js";
import { makeAwsCliExecutor, type AwsCliExecutorOptions } from "./cli.js";
import { makeAwsSsoMinter, makeAwsSsoLinkStore, makeAwsSsoPurgeHook, type AwsSsoMinter, type AwsSsoMinterOptions } from "./sso.js";
import { loadAwsAccessConfig, loadAwsSsoConfig } from "./config.js";

export interface RegisterAwsAccessOptions {
  readonly identity?: AwsStsProviderOptions;
  readonly executor?: AwsCliExecutorOptions;
  readonly sso?: AwsSsoMinterOptions;
}

export function registerAwsAccess(opts: RegisterAwsAccessOptions = {}): {
  provider: AwsIdentityProvider;
  executor: AwsExecutor;
  sso: AwsSsoMinter;
} {
  const { defaultRegion } = loadAwsAccessConfig();
  const ssoCfg = loadAwsSsoConfig();

  registerAwsSsoLinkStore(makeAwsSsoLinkStore());
  registerCredentialPurgeHook("aws-sso", makeAwsSsoPurgeHook());
  const sso = makeAwsSsoMinter({
    ...(ssoCfg.region ? { region: ssoCfg.region } : defaultRegion ? { region: defaultRegion } : {}),
    ...(ssoCfg.clientId ? { clientId: ssoCfg.clientId } : {}),
    ...(ssoCfg.scopes ? { scopes: ssoCfg.scopes } : {}),
    ...opts.sso,
  });

  registerAwsSsoCallbackCompleter({ complete: ({ state, code }) => sso.completeLink(state, code) });

  const provider = makeAwsStsProvider({ defaultRegion, mintUserSso: (req) => sso.mint(req), ...opts.identity });
  const executor = makeAwsCliExecutor({ defaultRegion, ...opts.executor });
  registerAwsIdentityProvider(provider);
  registerAwsExecutor(executor);
  return { provider, executor, sso };
}
