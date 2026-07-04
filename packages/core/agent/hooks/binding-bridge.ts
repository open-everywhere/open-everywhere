import { defineHook } from "eve/hooks";
import { stampBindingBridge } from "../identity/binding-bridge.js";
import type { BindableContext } from "../identity/binding.js";

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => stampBindingBridge(ctx as BindableContext),
    "turn.started": async (_event, ctx) => stampBindingBridge(ctx as BindableContext),
  },
});
