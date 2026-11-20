import { defineDynamic, type DynamicToolResult } from "eve/tools";
import { windowGrainOf, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { resolveBrowserKit } from "../access/browser-toolkit.js";
import { memoized, seatMemoKey } from "../access/window-gated.js";

function grainOf(ctx: BindableContext): WindowGrain {
  try {
    return windowGrainOf(ctx);
  } catch {
    return "standing";
  }
}

export default defineDynamic(async (ctx) => {
  const grain = await memoized(ctx, seatMemoKey(ctx), () => grainOf(ctx as unknown as BindableContext));
  return resolveBrowserKit(grain) as unknown as DynamicToolResult;
});
