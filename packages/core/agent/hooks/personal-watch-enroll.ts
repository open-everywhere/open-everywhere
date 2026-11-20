import { defineHook, type HookContext } from "eve/hooks";
import { actingPrincipalId, bindFrom, type BindableContext } from "../identity/binding.js";
import { parsePrincipalKey, tryPrincipalKey } from "../identity/principal-key.js";
import { enrollPersonalWatch } from "../personal-watch/state.js";
import { partitionOfBinding } from "../memory/partition.js";
import { offerFirstDayBrief, type FirstDayBriefDeps, type FirstDayBriefOutcome } from "../onboarding/first-day-brief.js";
import { proposeFirstDayBriefCard } from "../personal-watch/propose.js";
import { personAddress, readDmAudience } from "../channels/dm-audience.js";
import { optional } from "./control-refusal.js";

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

function liveFirstDayDeps(): FirstDayBriefDeps {
  return {
    propose: proposeFirstDayBriefCard(),
    dmStopped: async (org, principalKey) => {
      const p = parsePrincipalKey(principalKey);
      return p ? (await readDmAudience(org, personAddress(p.platform, p.id))).stopped : true;
    },
  };
}

export async function onDmTurn(binding: ReturnType<typeof bindFrom>, deps: { readonly enroll?: typeof enrollPersonalWatch; readonly firstDay?: FirstDayBriefDeps } = {}): Promise<FirstDayBriefOutcome | undefined> {
  try {
    const enrolled = await enrollFromBinding(binding, deps.enroll);
    if (enrolled === "skipped") return undefined;
    return await offerFirstDayBrief(binding, partitionOfBinding(binding).surfaceKey, deps.firstDay ?? liveFirstDayDeps());
  } catch {
    return undefined;
  }
}

async function onTurn(ctx: HookContext): Promise<void> {
  try {
    await onDmTurn(bindFrom(ctx as unknown as BindableContext));
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": optional("personal-watch-enroll", (_event, ctx) => onTurn(ctx)),
  },
});
