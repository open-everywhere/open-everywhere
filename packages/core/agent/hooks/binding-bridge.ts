import { defineHook } from "eve/hooks";
import { refreshBindingStamp, type BindableContext } from "../identity/binding.js";

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => void refreshBindingStamp(ctx as BindableContext),
    "turn.started": async (_event, ctx) => void refreshBindingStamp(ctx as BindableContext),
  },
});
