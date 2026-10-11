import { reservedRefNamespace } from "../credentials/reserved-refs.js";
import { describeReadableBy, readableByDefects, type ReadableBy } from "../access/read-grant.js";
import { webhookReach } from "./achievability.js";
import { WEBHOOK_AUTH_GRADES, type WebhookAuthGrade } from "./verifier.js";
import type { Domain } from "../memory/domain.js";
import { parseWebhookTarget } from "./target.js";

export type WebhookPosture = "trigger-only" | "content-bearing" | "projection";

export const WEBHOOK_POSTURES: readonly WebhookPosture[] = ["trigger-only", "content-bearing", "projection"] as const;

export interface WebhookHook {
  readonly id: string;
  readonly source: string;
  readonly secretRef: string | readonly string[];
  readonly broker: string;
  readonly target?: string;
  readonly instruction?: string;
  readonly readableBy: ReadableBy;
  readonly posture?: WebhookPosture;
  readonly project?: readonly string[];
  readonly authFloor?: WebhookAuthGrade;
}

export type FusedWebhookHook = WebhookHook & { readonly target: string; readonly instruction: string };

export function isFusedHook(hook: WebhookHook): hook is FusedWebhookHook {
  return typeof hook.target === "string" && hook.target.length > 0 && typeof hook.instruction === "string" && hook.instruction.trim().length > 0;
}

export function configHookPosture(hook: Pick<WebhookHook, "posture">): WebhookPosture {
  return hook.posture ?? "content-bearing";
}

export function configHookDisclosure(hook: Pick<WebhookHook, "posture" | "project">): {
  readonly redactPayload?: true;
  readonly project?: readonly string[];
} {
  switch (configHookPosture(hook)) {
    case "trigger-only":
      return { redactPayload: true };
    case "projection":
      return hook.project && hook.project.length > 0 ? { project: hook.project } : { redactPayload: true };
    case "content-bearing":
      return {};
  }
}

export function defineWebhook<T extends WebhookHook>(hook: T): T {
  return hook;
}

export function hookSecretRefs(hook: Pick<WebhookHook, "secretRef">): readonly string[] {
  return typeof hook.secretRef === "string" ? [hook.secretRef] : hook.secretRef;
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface WebhookValidationDeps {
  readonly domains?: readonly Domain[];
  readonly warn?: (message: string) => void;
}
export function assertWebhooksValid(hooks: readonly WebhookHook[], deps: WebhookValidationDeps = {}): void {
  const seen = new Set<string>();
  for (const h of hooks) {
    if (!h.id || !ID_RE.test(h.id)) {
      throw new Error(`webhook hook id ${JSON.stringify(h.id)} must be a non-empty url-safe token ([a-zA-Z0-9_-]+)`);
    }
    if (seen.has(h.id)) throw new Error(`duplicate webhook hook id "${h.id}"`);
    seen.add(h.id);
    if (!h.source || !h.source.trim()) {
      throw new Error(
        `webhook "${h.id}" is missing source — name the signature scheme its sender uses (\`source: "oe-standard-webhook"\` for a sender you configure, or a vendor's source like "github"); there is no default`,
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
            `deployment minted or captured for itself (an OAuth token, a vendor handshake key). Point at your own ref instead.`,
        );
      }
    }
    if (new Set(refs).size !== refs.length) {
      throw new Error(`webhook "${h.id}" repeats a secretRef — a rotation overlap lists DISTINCT refs (current first, then the outgoing one)`);
    }
    if (!h.broker || !h.broker.trim()) {
      throw new Error(`webhook "${h.id}" is missing broker — name the ONE home its secretRef(s) resolve through (\`broker: "env" | "db" | ...\`); there is no default`);
    }
    const hasTarget = h.target !== undefined;
    const hasInstruction = h.instruction !== undefined && h.instruction.trim().length > 0;
    if (hasTarget !== hasInstruction) {
      throw new Error(
        hasTarget
          ? `webhook "${h.id}" declares a target (${JSON.stringify(h.target)}) but no instruction — a fired channel with nothing to say. Add the instruction, or drop the target to declare an EMIT-ONLY hook whose consequences are decided by \`event\` routines.`
          : `webhook "${h.id}" declares an instruction but no target — there is nowhere for it to run. Add the target (a room such as "slack/TEAM/CHANNEL", or a person's DM such as "dm:slack/TEAM/USER"), or drop the instruction to declare an EMIT-ONLY hook whose consequences are decided by \`event\` routines.`,
      );
    }
    if (h.target !== undefined) {
      const parsed = parseWebhookTarget(h.target);
      if ("defect" in parsed) throw new Error(`webhook "${h.id}" target: ${parsed.defect}`);
    }
    const grantDefects = readableByDefects(h.readableBy);
    if (grantDefects.length > 0) {
      throw new Error(
        `webhook "${h.id}" has an invalid readableBy (which surfaces may read this hook's events — there is no default):\n` +
          grantDefects.map((d) => `  ${d}`).join("\n") +
          `\n  as written it would grant: ${describeReadableBy(h.readableBy)}`,
      );
    }
    if (h.posture !== undefined && !WEBHOOK_POSTURES.includes(h.posture)) {
      throw new Error(
        `webhook "${h.id}" has an unknown posture ${JSON.stringify(h.posture)} — how much of the payload may reach the model is ${WEBHOOK_POSTURES.join(" | ")}. ` +
          `Omit it for "content-bearing" (what every config hook did before the field existed).`,
      );
    }
    const posture = configHookPosture(h);
    if (posture === "projection") {
      if (!h.project || h.project.length === 0) {
        throw new Error(
          `webhook "${h.id}" declares posture "projection" but no \`project\` keys — a projection with nothing to project renders no payload at all, which is what posture "trigger-only" is for. Name the normalizer field keys to render, or change the posture.`,
        );
      }
      for (const [i, key] of h.project.entries()) {
        if (typeof key !== "string" || !key.trim()) {
          throw new Error(`webhook "${h.id}" project[${i}] is blank — each entry names one normalizer field key to render`);
        }
      }
      if (new Set(h.project).size !== h.project.length) {
        throw new Error(`webhook "${h.id}" repeats a \`project\` key — the list is rendered in declaration order, so a repeat would print one field twice`);
      }
    } else if (h.project !== undefined) {
      throw new Error(
        `webhook "${h.id}" sets \`project\` but its posture is "${posture}" — the key list is only read under posture "projection". As written it narrows nothing: ` +
          (posture === "trigger-only" ? "a trigger-only hook renders no payload at all." : "a content-bearing hook renders the WHOLE body."),
      );
    }
    if (h.authFloor !== undefined && !WEBHOOK_AUTH_GRADES.includes(h.authFloor)) {
      throw new Error(
        `webhook "${h.id}" has an unknown authFloor ${JSON.stringify(h.authFloor)} — the weakest acceptance a hook will take is ${WEBHOOK_AUTH_GRADES.join(" | ")}. ` +
          `Omit it for no floor (what every config hook did before the field existed).`,
      );
    }
    const reach = webhookReach(h, deps.domains);
    if (reach.impossible.length > 0) {
      throw new Error(
        `webhook "${h.id}" declares a consequence that can never happen:\n` +
          reach.impossible.map((d) => `  ${d}`).join("\n") +
          `\n  This is refused rather than warned because it is decidable now and no later state makes it match.`,
      );
    }
    for (const warning of reach.unreachable) {
      (deps.warn ?? ((m: string) => console.warn(m)))(`[open-everywhere:webhooks] "${h.id}": ${warning}`);
    }
  }
}

export function hooksSharingSecretRef(hooks: readonly WebhookHook[], hookId: string, ref: string): readonly string[] {
  return hooks.filter((h) => h.id !== hookId && hookSecretRefs(h).includes(ref)).map((h) => h.id);
}

export function findWebhook(hooks: readonly WebhookHook[], id: string): WebhookHook | undefined {
  return hooks.find((h) => h.id === id);
}
