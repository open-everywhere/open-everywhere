import { defineDynamic } from "eve/tools";
import { windowGrainOf, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { resolveBrowserKit } from "../access/browser-toolkit.js";

function grainOf(ctx: BindableContext): WindowGrain {
  try {
    return windowGrainOf(ctx);
  } catch {
    return "standing";
  }
}

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      return resolveBrowserKit(grainOf(ctx as BindableContext));
    },
  },
});
