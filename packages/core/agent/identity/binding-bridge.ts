import { defineState } from "eve/context";
import { platformFromKind } from "./platform.js";
import type { BindableContext } from "./binding.js";

export interface BridgedIdentity {
  readonly platform: string;
  readonly principalId?: string;
  readonly principalType?: string;
  readonly authenticator?: string;
  readonly attributes: Readonly<Record<string, string>>;
}

const slot = defineState<BridgedIdentity | null>("open-everywhere.binding-bridge", () => null);

function flatten(a: Readonly<Record<string, string | readonly string[]>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a ?? {})) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) out[k] = v[0];
  }
  return out;
}

export function stampBindingBridge(ctx: BindableContext): void {
  try {
    const platform = platformFromKind(ctx.channel?.kind);
    if (!platform || platform === "local") return;
    const auth = ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
    const attributes = flatten(auth?.attributes);
    if (Object.keys(attributes).length === 0) return;
    slot.update(() => ({
      platform,
      principalId: auth?.principalId && auth.principalId.length > 0 ? auth.principalId : undefined,
      principalType: auth?.principalType,
      authenticator: auth?.authenticator,
      attributes,
    }));
  } catch {
  }
}

export function readBindingBridge(): BridgedIdentity | null {
  try {
    return slot.get();
  } catch {
    return null;
  }
}

export function bridgedContext(b: BridgedIdentity): BindableContext {
  return {
    channel: { kind: b.platform },
    session: {
      auth: {
        current: {
          attributes: b.attributes,
          principalId: b.principalId,
          principalType: b.principalType,
          authenticator: b.authenticator,
        },
      },
    },
  };
}
