import { defineHook, type HookContext } from "eve/hooks";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { detectSessionLimitPark, handleSessionLimitPark } from "../channels/session-park.js";

export default defineHook({
  events: {
    "input.requested": async (event, ctx: HookContext) => {
      try {
        const park = detectSessionLimitPark((event.data as { requests?: unknown } | undefined)?.requests);
        if (!park) return;
        const p = resolvePartition(ctx);
        const token = bareTokenFromEveContext(ctx.channel?.continuationToken) ?? ctx.channel?.continuationToken;
        const sessionId = typeof ctx.session?.id === "string" && ctx.session.id.length > 0 ? ctx.session.id : undefined;
        const outcome = await handleSessionLimitPark(
          {
            org: p.org,
            platform: p.platform,
            workspace: p.workspace,
            surface: p.surface,
            domainKey: domainKeyOf(p),
            token,
            ...(sessionId !== undefined ? { sessionId } : {}),
          },
          park,
        );
        console.warn(
          `[open-everywhere:session-park] session hit eve's ${park.kind}-token bound and PARKED ` +
            `(org=${p.org} surface=${p.surfaceKey} token=${JSON.stringify(token)} remedy=${outcome.remedy}` +
            `${outcome.registryKey ? ` key=${outcome.registryKey}` : ""}${outcome.audited ? "" : " audit=throttled"})`,
        );
      } catch (err) {
        console.warn(`[open-everywhere:session-park] park handling skipped: ${String(err)}`);
      }
    },
  },
});
