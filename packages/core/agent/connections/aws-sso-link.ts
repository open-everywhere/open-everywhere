export interface AwsSsoLinkStore {
  read(principalId: string): Promise<string | null>;
  write(principalId: string, token: string): Promise<void>;
  clear(principalId: string): Promise<void>;
}

let registered: AwsSsoLinkStore | undefined;

export function registerAwsSsoLinkStore(store: AwsSsoLinkStore): void {
  registered = store;
}

export function resetAwsSsoLinkStore(): void {
  registered = undefined;
}

export function awsSsoLinkStore(): AwsSsoLinkStore | undefined {
  return registered;
}

export function requireAwsSsoLinkStore(): AwsSsoLinkStore {
  if (!registered) {
    throw new Error(
      "no AWS-SSO link store is registered — the AWS adapter (packages/adapters/agent/aws) is not " +
        "wired. Register it at boot (register-adapters.ts). Fail-closed: no per-user AWS SSO link.",
    );
  }
  return registered;
}
