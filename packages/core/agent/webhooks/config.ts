import { RUNTIME_HOOK_ID_PREFIX } from "./runtime-hook.js";
import { reservedRefNamespace } from "../credentials/reserved-refs.js";

export interface WebhookHook {
  readonly id: string;
  readonly source: string;
  readonly secretRef: string | readonly string[];
  readonly broker: string;
  readonly target: string;
  readonly instruction: string;
}

export function defineWebhook(hook: WebhookHook): WebhookHook {
  return hook;
}

export function hookSecretRefs(hook: Pick<WebhookHook, "secretRef">): readonly string[] {
  return typeof hook.secretRef === "string" ? [hook.secretRef] : hook.secretRef;
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

export function assertWebhooksValid(hooks: readonly WebhookHook[]): void {
  const seen = new Set<string>();
  for (const h of hooks) {
    if (!h.id || !ID_RE.test(h.id)) {
      throw new Error(`webhook hook id ${JSON.stringify(h.id)} must be a non-empty url-safe token ([a-zA-Z0-9_-]+)`);
    }
    if (h.id.startsWith(RUNTIME_HOOK_ID_PREFIX)) {
      throw new Error(
        `webhook hook id "${h.id}" starts with the reserved "${RUNTIME_HOOK_ID_PREFIX}" prefix — that namespace belongs to hooks created from chat ` +
          `(they are minted host-side and never appear in config). Rename it.`,
      );
    }
    if (seen.has(h.id)) throw new Error(`duplicate webhook hook id "${h.id}"`);
    seen.add(h.id);
    if (!h.source || !h.source.trim()) {
      throw new Error(
        `webhook "${h.id}" is missing source — name the signature scheme its sender uses (\`source: "oe-hmac"\` for a sender you configure, or a vendor's source like "github"); there is no default`,
      );
    }
    const refs = hookSecretRefs(h);
    if (refs.length === 0) {
      throw new Error(`webhook "${h.id}" has an empty secretRef list — it needs at least one ref (current key first)`);
    }
    for (const [i, ref] of refs.entries()) {
      if (typeof ref !== "string" || !ref.trim()) {
        throw new Error(`webhook "${h.id}" secretRef[${i}] is blank — each entry must name where the shared secret lives (a ref, never the value)`);
      }
      const reserved = reservedRefNamespace(ref);
      if (reserved) {
        throw new Error(
          `webhook "${h.id}" secretRef[${i}] is in the reserved "${reserved}" namespace — that namespace holds secret material this ` +
            `deployment minted for itself (a chat-created hook's signing secret, an OAuth token). Point at your own ref instead.`,
        );
      }
    }
    if (new Set(refs).size !== refs.length) {
      throw new Error(`webhook "${h.id}" repeats a secretRef — a rotation overlap lists DISTINCT refs (current first, then the outgoing one)`);
    }
    if (!h.broker || !h.broker.trim()) {
      throw new Error(`webhook "${h.id}" is missing broker — name the ONE home its secretRef(s) resolve through (\`broker: "env" | "db" | ...\`); there is no default`);
    }
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
