import { clearPersonOptOut, readPersonOptOut, setPersonOptOut, type PersonOptOutWhere } from "../identity/person-opt-out.js";
import { registerHomeAction, registerHomeSection, type HomeBlock, type HomeViewer } from "./home-view.js";

export const OPT_OUT_HOME_ACTIONS = {
  on: "privacy.opt-out",
  off: "privacy.opt-in",
} as const;

const SCOPE_NOTE =
  "When this is on, I save no memory from your own turns with me. In a shared conversation, a later turn by somebody else can still save something you said, and what other people tell me is not covered. A question you ask a domain from your DM is not covered yet: the domain can still save it. I also refuse when somebody else hands me one of your messages with a shortcut. " +
  "Your own requests still work. Admins can see this choice in the audit log.";

function whereOf(viewer: HomeViewer): PersonOptOutWhere {
  return {
    org: viewer.org,
    platform: viewer.platform,
    workspace: viewer.workspace,
    surface: viewer.personal?.surface ?? "home",
    principalKey: viewer.principalId,
  };
}

async function optOutBlocks(viewer: HomeViewer): Promise<readonly HomeBlock[]> {
  const blocks: HomeBlock[] = [{ kind: "divider" }, { kind: "heading", text: "Acting on your content" }, { kind: "note", text: SCOPE_NOTE }];
  const state = await readPersonOptOut(viewer.org, viewer.principalId);
  if (!state.readable) {
    blocks.push({ kind: "note", text: "I could not read this setting just now. Until I can, I treat it as on. Try Refresh." });
    return blocks;
  }
  if (state.optedOut) {
    blocks.push({ kind: "text", text: `On since ${state.since?.slice(0, 10) ?? "an unknown date"}: I do not act on your content.` });
    blocks.push({ kind: "buttons", buttons: [{ id: OPT_OUT_HOME_ACTIONS.off, label: "Turn off" }] });
  } else {
    blocks.push({ kind: "text", text: "Off: I can remember things from our conversations." });
    blocks.push({ kind: "buttons", buttons: [{ id: OPT_OUT_HOME_ACTIONS.on, label: "Turn on" }] });
  }
  return blocks;
}

registerHomeSection({ id: "privacy.opt-out", order: 40, build: optOutBlocks });

registerHomeAction(OPT_OUT_HOME_ACTIONS.on, async (viewer) => {
  const r = await setPersonOptOut(whereOf(viewer), "app-home");
  return { notice: r === "set" ? "Done. I no longer act on your content." : "It was already on." };
});

registerHomeAction(OPT_OUT_HOME_ACTIONS.off, async (viewer) => {
  const r = await clearPersonOptOut(whereOf(viewer), "app-home");
  return { notice: r === "cleared" ? "Done. I can remember things from our conversations again." : "It was already off." };
});
