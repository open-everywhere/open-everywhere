import { agentDisplayName } from "../identity/bot-name.js";
import { memoryLineForReader } from "../memory/provenance-mark.js";
import {
  editPersonalMemoryItem,
  exportPersonalMemory,
  forgetPersonalMemoryItem,
  readDomainMemory,
  readPersonalMemory,
  type MemorySelfServiceVia,
} from "../memory/visible.js";
import { registerHomeAction, registerHomeSection, type HomeBlock, type HomeItemAction, type HomeViewer } from "./home-view.js";

const HOME_PERSONAL_ITEMS_MAX = 40;
const HOME_DOMAINS_MAX = 5;
const HOME_DOMAIN_ITEMS_MAX = 8;

export const MEMORY_HOME_ACTIONS = {
  edit: "memory.edit",
  forget: "memory.forget",
  exportAll: "memory.export",
  refresh: "memory.refresh",
} as const;

function viaOf(viewer: HomeViewer): MemorySelfServiceVia | undefined {
  return viewer.platform === "slack" ? "slack-app-home" : undefined;
}

const NO_DOOR = { notice: "This page cannot change memory from here yet." } as const;

const ITEM_ACTIONS: readonly HomeItemAction[] = [
  { id: MEMORY_HOME_ACTIONS.edit, label: "Edit", kind: "edit" },
  { id: MEMORY_HOME_ACTIONS.forget, label: "Forget", kind: "confirm", confirm: { title: "Forget this?", yes: "Forget it" } },
];

async function personalBlocks(viewer: HomeViewer): Promise<readonly HomeBlock[]> {
  const blocks: HomeBlock[] = [
    { kind: "heading", text: "What I remember about you" },
    {
      kind: "note",
      text:
        "Only you can see this page. It lists the lines in your personal memory — what I keep from our direct messages. " +
        "Edit changes a line. Forget removes it. Export sends you every memory file in full. " +
        "I keep a private record of each change, but never the words.",
    },
    { kind: "buttons", buttons: [{ id: MEMORY_HOME_ACTIONS.exportAll, label: "Export" }, { id: MEMORY_HOME_ACTIONS.refresh, label: "Refresh" }] },
  ];
  if (!viewer.personal) {
    blocks.push({ kind: "note", text: "I could not open your direct-message memory just now. It is not empty — it is unavailable. Try Refresh." });
    return blocks;
  }
  const { items } = await readPersonalMemory(viewer.personal);
  if (items.length === 0) {
    blocks.push({ kind: "text", text: "I do not remember anything about you yet. In a direct message, tell me something and ask me to remember it." });
    return blocks;
  }
  for (const item of items.slice(0, HOME_PERSONAL_ITEMS_MAX)) {
    blocks.push({ kind: "item", text: memoryLineForReader(item.text), ...(item.section ? { label: item.section } : {}), ref: item.sha256, actions: ITEM_ACTIONS });
  }
  if (items.length > HOME_PERSONAL_ITEMS_MAX) {
    blocks.push({ kind: "note", text: `${items.length - HOME_PERSONAL_ITEMS_MAX} more lines are not shown here. Export gives you all ${items.length}.` });
  }
  return blocks;
}

async function domainBlocks(viewer: HomeViewer): Promise<readonly HomeBlock[]> {
  const blocks: HomeBlock[] = [{ kind: "divider" }, { kind: "heading", text: "What your domains know" }];
  if (viewer.trust !== "internal") {
    blocks.push({ kind: "note", text: "On this page, domain memory is shown only to full members of this workspace." });
    return blocks;
  }
  if (viewer.domains.length === 0) {
    blocks.push({ kind: "note", text: "None of your channels belongs to a domain that keeps memory." });
    return blocks;
  }
  for (const { domain, rooms } of viewer.domains.slice(0, HOME_DOMAINS_MAX)) {
    blocks.push({ kind: "heading", text: domain.title ?? domain.name });
    const groups = await readDomainMemory(viewer.org, domain);
    const items = groups.flatMap((g) => g.items);
    const unavailable = groups.filter((g) => g.unavailable).length;
    if (unavailable > 0) blocks.push({ kind: "note", text: `${unavailable} of this domain's memory sources could not be read just now.` });
    if (items.length === 0 && unavailable === 0) blocks.push({ kind: "note", text: "This domain has not remembered anything yet." });
    for (const item of items.slice(0, HOME_DOMAIN_ITEMS_MAX)) {
      blocks.push({ kind: "item", text: memoryLineForReader(item.text), ...(item.section ? { label: item.section } : {}), actions: [] });
    }
    const more = items.length - HOME_DOMAIN_ITEMS_MAX;
    const room = rooms[0]!;
    blocks.push({
      kind: "room",
      text: more > 0
        ? `${more} more lines are in the memory canvas of this channel. To correct or forget one, ask me there:`
        : "To correct or forget one of these, ask me in this channel:",
      room,
    });
  }
  if (viewer.domains.length > HOME_DOMAINS_MAX) {
    blocks.push({ kind: "note", text: `You are in ${viewer.domains.length - HOME_DOMAINS_MAX} more domains. Each one's channel shows its memory canvas.` });
  }
  return blocks;
}

registerHomeSection({ id: "memory.personal", order: 10, build: personalBlocks });
registerHomeSection({ id: "memory.domains", order: 30, build: domainBlocks });

registerHomeAction(MEMORY_HOME_ACTIONS.edit, async (viewer, ref, input) => {
  const via = viaOf(viewer);
  if (!via) return NO_DOOR;
  if (!viewer.personal || ref === undefined) return { notice: "I could not find that line. Open the page again." };
  const r = await editPersonalMemoryItem({ partition: viewer.personal, sha256: ref, text: input ?? "", principalId: viewer.principalId, via });
  switch (r.kind) {
    case "edited":
      return { notice: "Saved. I will use the new wording from now on." };
    case "unchanged":
      return { notice: "Nothing changed — the line already says that." };
    case "gone":
      return { notice: "That line is not in your memory any more, so there was nothing to edit." };
    case "refused":
      return { notice: r.reason };
  }
});

registerHomeAction(MEMORY_HOME_ACTIONS.forget, async (viewer, ref) => {
  const via = viaOf(viewer);
  if (!via) return NO_DOOR;
  if (!viewer.personal || ref === undefined) return { notice: "I could not find that line. Open the page again." };
  const r = await forgetPersonalMemoryItem({ partition: viewer.personal, sha256: ref, principalId: viewer.principalId, via });
  return r.kind === "forgotten"
    ? { notice: "Forgotten. That line is gone from your memory." }
    : { notice: "That line is not in your memory any more, so there was nothing to forget." };
});

registerHomeAction(MEMORY_HOME_ACTIONS.exportAll, async (viewer) => {
  const via = viaOf(viewer);
  if (!via) return NO_DOOR;
  if (!viewer.personal) return { notice: "I could not open your memory just now. Try again." };
  const nowIso = new Date().toISOString();
  const { markdown, items } = await exportPersonalMemory({
    partition: viewer.personal,
    principalId: viewer.principalId,
    via,
    title: `What ${agentDisplayName()} remembers about you`,
    nowIso,
  });
  return {
    notice: items === 0 ? "Your memory is empty, so the export has no lines." : `Here is everything I remember about you: ${items} lines.`,
    file: { filename: `memory-${nowIso.slice(0, 10)}.md`, title: "Your memory", content: markdown },
  };
});

registerHomeAction(MEMORY_HOME_ACTIONS.refresh, async () => ({ notice: "" }));
