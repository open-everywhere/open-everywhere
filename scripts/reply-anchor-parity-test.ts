// proves: PAR-origin-placement-carry

import assert from "node:assert/strict";
import { assertCoreDistFresh } from "./core-dist-freshness.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wakeOriginCodec, surfaceParityFor } from "@open-everywhere/core/agent/adapter-api.js";
import {
  unifiedPlacementRef,
  sameUnifiedPlacement,
  sameUnifiedConversation,
  withCarriedPlacement,
  type UnifiedWakeOrigin,
} from "@open-everywhere/core/agent/channels/unified-window.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";

assertCoreDistFresh();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const PLATFORMS = ["slack", "discord", "teams", "github", "linear", "notion"] as const;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();
registerGithubProvider();
registerLinearProvider();
registerNotionProvider();

{
  const NAME_BRANCH = /\bplatform\s*[!=]==?\s*"(?:slack|discord|teams|github|linear|notion)"\s*(?:\?|&&|\|\||\))/u;
  const codeOf = (line: string) => line.replace(/\/\/.*$/u, "");
  const hasNameBranch = (text: string) => text.split("\n").some((l) => NAME_BRANCH.test(codeOf(l)));
  const GUARDED = ["packages/core/agent/channels/unified.ts", "packages/core/agent/channels/unified-window.ts"] as const;
  for (const rel of GUARDED) {
    const src = readFileSync(join(root, rel), "utf8");
    ok(
      !hasNameBranch(src),
      `🔴 ${rel}: NO PLATFORM NAME DECIDES A PLACEMENT — the anchor question is asked of the codec registry. A \`platform === "<name>"\` branch here is OPE-1826 returning: a second surface with a placement outside its conversation identity would again have nowhere to declare it`,
    );
    ok(src.includes("unifiedPlacementRef") || src.includes("placementRef"), `${rel} PRECONDITION: the file read really is the one that owns the placement road`);
  }
  ok(
    hasNameBranch(`const replyAnchor = origin.platform === "slack" ? origin.replyAnchorTs : undefined;`),
    "🔴 NEGATIVE CONTROL: the pattern fires on the exact expression OPE-1826 removed — so the two clean reads above are measurements, not a regex that matches nothing",
  );
  ok(
    hasNameBranch(`const replyAnchor = origin.platform === "slack" ? origin.replyAnchorTs : undefined; // OPE-1826`),
    "🔴 NEGATIVE CONTROL: …and it still fires with a TRAILING COMMENT on the same line. Exempting a line that holds a `//` anywhere is the hole this shape closes, and a trailing note is the likeliest way the defect comes back",
  );
  ok(
    hasNameBranch(`  if (origin.platform === "slack") return origin.replyAnchorTs;`),
    "🔴 NEGATIVE CONTROL: …and on the BRACELESS statement form, which the old tail missed while the prose beside it claimed to catch a statement",
  );
  ok(
    !hasNameBranch(`  // This line read \`origin.platform === "slack" ? origin.replyAnchorTs : undefined\`, which was the defect.`),
    "NEGATIVE CONTROL: …and it does NOT fire on the comment that records the removal — the fix must not be undone to keep this test green",
  );
}

{
  for (const platform of PLATFORMS) {
    const codec = wakeOriginCodec(platform);
    ok(codec !== undefined, `${platform}: a wake-origin codec is registered — without one there is no placement question to ask`);
    const hasRef = codec?.placementRef !== undefined;
    const hasCarry = codec?.carryPlacement !== undefined;
    ok(
      hasRef === hasCarry,
      `🔴 ${platform}: \`placementRef\` and \`carryPlacement\` are declared TOGETHER or not at all — an axis nothing can carry, and a carry on an axis no comparison can see, are each incoherent, and either half alone is how OPE-1826's half-state read as complete`,
    );
    const declared = surfaceParityFor(platform)?.["origin-placement-carry"];
    const claims = declared === "supported" || (typeof declared === "object" && declared !== null && "supported" in declared);
    ok(claims === hasRef, `${platform}: the parity ledger and the codec agree about whether this surface has a placement axis at all`);
  }
  const withAxis = PLATFORMS.filter((p) => wakeOriginCodec(p)?.placementRef !== undefined);
  ok(withAxis.join(",") === "slack,discord", "🔴 PRECONDITION: exactly Slack and Discord carry a placement axis today — Slack's `replyAnchorTs` and Discord's `messageId`. Without this the equality above would hold over six codecs that all declare nothing");
}

{
  const ORIGINS: ReadonlyArray<{ readonly platform: string; readonly origin: UnifiedWakeOrigin; readonly expect: string | undefined; readonly why: string }> = [
    {
      platform: "slack",
      origin: { platform: "slack", channelId: "C1", replyAnchorTs: "1757664380.000100" } as UnifiedWakeOrigin,
      expect: "1757664380.000100",
      why: "`replyAnchorTs` is placement ONLY and stays outside `threadRef`, so two top-level wakes in one channel are one conversation holding two different anchors",
    },
    {
      platform: "discord",
      origin: { platform: "discord", channelId: "CH", messageId: "1200000000000000001" } as UnifiedWakeOrigin,
      expect: "1200000000000000001",
      why: "a Discord reply hangs under a MESSAGE id, which its conversation identity does not carry (OPE-1826)",
    },
    {
      platform: "teams",
      origin: { platform: "teams", conversationId: "19:chan@thread.tacv2", replyToActivityId: "act-1" } as UnifiedWakeOrigin,
      expect: undefined,
      why: "the placement is INSIDE the conversation identity — `threadRef` keys on `replyToActivityId`, so two origins that pass the conversation test already agree on placement",
    },
    { platform: "github", origin: { platform: "github", repo: "acme/web", issueNumber: 42 } as UnifiedWakeOrigin, expect: undefined, why: "a comment hangs on the issue, which is the conversation" },
    { platform: "linear", origin: { platform: "linear", issueId: "OPE-42" } as UnifiedWakeOrigin, expect: undefined, why: "a comment hangs on the issue, which is the conversation" },
    { platform: "notion", origin: { platform: "notion", pageId: "page-1", discussionId: "D1" } as UnifiedWakeOrigin, expect: undefined, why: "a comment hangs in its discussion, which IS the thread key" },
  ];

  ok(ORIGINS.length === 6, "OPE-1838: the placement road is driven on all SIX surfaces — a list short of one is a surface nobody asked");

  for (const o of ORIGINS) {
    ok(
      unifiedPlacementRef(o.origin) === o.expect,
      `${o.platform}: the SHARED entry point answers this surface's placement from its own codec — ${o.why}`,
    );
  }

  ok(
    unifiedPlacementRef({ platform: "nosuchsurface", channelId: "X", replyAnchorTs: "1.1" } as unknown as UnifiedWakeOrigin) === undefined,
    "an UNREGISTERED platform answers `undefined` — the road never guesses a placement from a field it recognises on another surface",
  );
  ok(
    unifiedPlacementRef({ platform: "slack", channelId: "C1" } as UnifiedWakeOrigin) === undefined,
    "🔴 NEGATIVE CONTROL: a Slack origin minted for a message that answers nothing — a routine fire, a webhook post-back — carries NO anchor, and the road says so rather than inventing one",
  );
  ok(
    unifiedPlacementRef({ platform: "slack", channelId: "C1", replyAnchorTs: "" } as UnifiedWakeOrigin) === undefined,
    "slack: EMPTINESS IS ABSENCE — a stored `\"\"` is not an anchor, the third of the three reads that file takes that way",
  );

  const codec = wakeOriginCodec("slack")!;
  const realRef = codec.placementRef;
  try {
    (codec as { placementRef?: unknown }).placementRef = () => {
      throw new Error("a provider arm threw");
    };
    ok(
      unifiedPlacementRef({ platform: "slack", channelId: "C1", replyAnchorTs: "1.1" } as UnifiedWakeOrigin) === undefined,
      "a THROWING codec arm answers `undefined` — the same direction an absent arm reads, so a broken provider degrades to the pre-feature behaviour and never to a guessed placement",
    );
  } finally {
    (codec as { placementRef?: unknown }).placementRef = realRef;
  }
  ok(unifiedPlacementRef({ platform: "slack", channelId: "C1", replyAnchorTs: "1.1" } as UnifiedWakeOrigin) === "1.1", "…and the real arm is back on the road after the drive");
}

{
  const a = { platform: "slack", channelId: "C1", replyAnchorTs: "100.000100" } as UnifiedWakeOrigin;
  const b = { platform: "slack", channelId: "C1", replyAnchorTs: "200.000200" } as UnifiedWakeOrigin;
  ok(sameUnifiedConversation(a, b), "🔴 OPE-1827 PRECONDITION: two top-level Slack wakes in one channel ARE one conversation — the equality a retargeting caller reads");
  ok(!sameUnifiedPlacement(a, b), "🔴 OPE-1827: …and they are NOT one placement. This is the predicate whose absence let a coalesced task keep the anchor it already had, inside the right room and under the wrong message");
  ok(sameUnifiedPlacement(a, { ...a }), "NEGATIVE CONTROL: two origins naming the SAME anchor do compare equal — so the inequality above is the anchors differing, not a predicate that always refuses");
  ok(
    !sameUnifiedPlacement(a, { platform: "discord", channelId: "C1", messageId: "100.000100" } as UnifiedWakeOrigin),
    "a CROSS-PLATFORM pair is never one placement — two surfaces' unrelated id spaces are not comparable, so the answer is `false` rather than a string match across them",
  );
}

{
  type SlackOrigin = Extract<UnifiedWakeOrigin, { readonly platform: "slack" }>;
  const anchored: SlackOrigin = { platform: "slack", channelId: "C1", replyAnchorTs: "100.000100" };
  const anchorless: SlackOrigin = { platform: "slack", channelId: "C1" };
  const threaded: SlackOrigin = { platform: "slack", channelId: "C1", threadTs: "50.000050" };

  ok(
    (withCarriedPlacement(anchorless, anchored) as { replyAnchorTs?: string }).replyAnchorTs === "100.000100",
    "🔴 THE GAP IS FILLED: a target holding no placement takes the source's, which is the whole fix — without it a sibling wake's answer lands FLAT on the channel, under no message",
  );
  ok(
    (withCarriedPlacement(anchored, { ...anchored, replyAnchorTs: "999.000999" }) as { replyAnchorTs?: string }).replyAnchorTs === "100.000100",
    "🔴 AN EXISTING PLACEMENT IS NEVER OVERWRITTEN — the model named THAT wake, and a carry that moved a post would be the defect the fix is for, inverted",
  );
  ok(
    (withCarriedPlacement(threaded, anchored) as { replyAnchorTs?: string }).replyAnchorTs === undefined,
    "a THREADED target is already placed — its answer goes in that thread and must never re-anchor on a trigger message",
  );
  ok(withCarriedPlacement(anchorless, anchorless) === anchorless, "a source with no placement to give hands the target back UNCHANGED — the same object, so the no-carry road stays byte-identical");
  ok(
    withCarriedPlacement(anchorless, { platform: "discord", channelId: "C1", messageId: "1" } as UnifiedWakeOrigin) === anchorless,
    "a CROSS-PLATFORM source carries nothing — a placement is not portable between two surfaces' id spaces",
  );

  const codec = wakeOriginCodec("slack")!;
  const realCarry = codec.carryPlacement;
  try {
    (codec as { carryPlacement?: unknown }).carryPlacement = (target: UnifiedWakeOrigin) => ({ ...target, channelId: "C-ELSEWHERE", replyAnchorTs: "100.000100" });
    ok(
      withCarriedPlacement(anchorless, anchored) === anchorless,
      "🔴 A CODEC ARM THAT CHANGES THE CONTAINER IS REFUSED — core re-tests the carried origin for the conversation the caller proved, so a provider cannot move a post into another room through the carry. Without this line the property would rest on an arm's good behaviour, which is the one thing a comment cannot prove",
    );
  } finally {
    (codec as { carryPlacement?: unknown }).carryPlacement = realCarry;
  }
  ok(
    (withCarriedPlacement(anchorless, anchored) as { replyAnchorTs?: string }).replyAnchorTs === "100.000100",
    "…and the real arm is back on the road after the drive",
  );
}

console.log(`✓ reply-anchor-parity: ${n} assertions — 6 surfaces, one road, no platform name decides a placement`);
