import { defineDynamic } from "eve/tools";
import { windowGrainOf, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { resolveBrowserKit, registeredBrowserToolkit, BROWSER_TOOL_NAMES, BROWSER_TOOLS_SLUG } from "../access/browser-toolkit.js";

for (const name of BROWSER_TOOL_NAMES) {
  preRegisterDynamicEntry(BROWSER_TOOLS_SLUG, name, {
    execute: (input: unknown, ctx: unknown) => {
      const entry = registeredBrowserToolkit()?.[name];
      if (entry === undefined) {
        throw new Error(`${name} is not available — the agent-browser capability is not armed in this deployment (browser.enabled).`);
      }
      return entry.execute(input, ctx);
    },
  });
}

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
