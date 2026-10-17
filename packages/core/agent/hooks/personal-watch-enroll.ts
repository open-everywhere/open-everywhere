import { defineHook, type HookContext } from "eve/hooks";
import { actingPrincipalId, bindFrom, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { enrollPersonalWatch } from "../personal-watch/state.js";
import { partitionOfBinding } from "../memory/partition.js";

const SEEN = new Set<string>();

export async function enrollFromBinding(binding: ReturnType<typeof bindFrom>, enroll: typeof enrollPersonalWatch = enrollPersonalWatch): Promise<"enrolled" | "already" | "failed" | "skipped"> {
  if (binding.mode !== "dm" || binding.trust !== "internal") return "skipped";
  const acting = actingPrincipalId(binding);
  const key = acting ? tryPrincipalKey(binding.platform, binding.workspace, acting) : undefined;
  if (!key) return "skipped";
  const memo = `${binding.org}|${key}`;
  if (SEEN.has(memo)) return "already";
  const r = await enroll(binding.org, key, new Date().toISOString(), { firstDm: partitionOfBinding(binding).surfaceKey });
  if (r !== "failed") SEEN.add(memo);
  return r;
}

async function onTurn(ctx: HookContext): Promise<void> {
  try {
    await enrollFromBinding(bindFrom(ctx as unknown as BindableContext));
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => onTurn(ctx),
  },
});
