export interface WebhookHook {
  readonly id: string;
  readonly secretEnv: string;
  readonly target: string;
  readonly instruction: string;
}

export function defineWebhook(hook: WebhookHook): WebhookHook {
  return hook;
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

export function assertWebhooksValid(hooks: readonly WebhookHook[]): void {
  const seen = new Set<string>();
  for (const h of hooks) {
    if (!h.id || !ID_RE.test(h.id)) {
      throw new Error(`webhook hook id ${JSON.stringify(h.id)} must be a non-empty url-safe token ([a-zA-Z0-9_-]+)`);
    }
    if (seen.has(h.id)) throw new Error(`duplicate webhook hook id "${h.id}"`);
    seen.add(h.id);
    if (!h.secretEnv || !h.secretEnv.trim()) throw new Error(`webhook "${h.id}" is missing secretEnv (the env var name holding its shared secret)`);
    const parts = h.target.split("/");
    if (parts.length !== 3 || parts[0] !== "slack" || !parts[1] || !parts[2]) {
      throw new Error(`webhook "${h.id}" target must be a fully-qualified "slack/TEAM/CHANNEL" surface, got ${JSON.stringify(h.target)}`);
    }
    if (!h.instruction || !h.instruction.trim()) throw new Error(`webhook "${h.id}" is missing an instruction (what the agent should do when it fires)`);
  }
}

export function findWebhook(hooks: readonly WebhookHook[], id: string): WebhookHook | undefined {
  return hooks.find((h) => h.id === id);
}
