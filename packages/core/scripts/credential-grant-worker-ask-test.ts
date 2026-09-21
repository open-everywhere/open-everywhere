import assert from "node:assert/strict";

import { grantCardText, type GrantAskWorkerOrigin } from "../agent/access/credential-grant-card.js";
import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { WORKER_WITHHELD_TOOLS, allowedOnWorkerSeat } from "../agent/access/worker-seat.js";
import { workerOnlyTools } from "../agent/access/worker-capabilities.js";
import { WORKER_ONLY_TOOLS_STANDING, WORKER_ONLY_TOOLS_THREAD } from "../agent/access/worker-capability-index.generated.js";
import { delegationRootSessionId, windowGrainOf, type BindableContext } from "../agent/identity/binding.js";
import { grantScopeKey, mayRaiseGrantAsk, requestCredentialGrantEntry, UNNAMED_SEAT_LABEL } from "../agent/tools/request_credential_grant.js";
import type { CredentialGrantAskRow } from "../agent/operational/credential-grant-rows.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const seatCtx = (grain: string, id = "sess-seat"): BindableContext =>
  ({ session: { id, auth: { current: { attributes: { oe_grain: grain } } } } }) as BindableContext;

const workerCtx = (input: { id: string; parentSessionId: string; rootSessionId?: string }): BindableContext =>
  ({
    session: {
      id: input.id,
      auth: { current: { attributes: { oe_grain: "standing" } } },
      parent: { callId: "call-1", sessionId: input.parentSessionId, ...(input.rootSessionId === undefined ? {} : { rootSessionId: input.rootSessionId }) },
    },
  }) as BindableContext;

eq(windowGrainOf(seatCtx("standing")), "standing", "the standing fixture does not resolve the standing grain — every leg below would measure the wrong seat");
eq(windowGrainOf(seatCtx("thread")), "thread", "the thread fixture does not resolve the thread grain");
eq(
  windowGrainOf(workerCtx({ id: "sess-worker", parentSessionId: "sess-seat" })),
  "task",
  "🔴 the worker fixture does not resolve grain `task` — the subagent-child override (OPE-393) is what makes this whole file the right test",
);

for (const grain of ["standing", "native", "thread"]) {
  ok(
    !mayRaiseGrantAsk(seatCtx(grain)),
    `🔴 a ${grain} conversational seat may still raise a grant ask — OPE-2023 moved the verb to the worker, and a seat that holds it raises an ask for a tool it can never meet`,
  );
}
ok(
  mayRaiseGrantAsk(workerCtx({ id: "sess-worker", parentSessionId: "sess-seat" })),
  "🔴 a delegated worker may not raise a grant ask — this is the OPE-1343 defect, and after OPE-2023 the verb has no reachable caller AT ALL while it holds",
);

const fireCtx = { session: { id: "sess-fire", auth: { current: { attributes: { oe_grain: "task" } } } } } as BindableContext;
eq(windowGrainOf(fireCtx), "task", "the fire fixture does not resolve grain `task` — leg 2 would then prove nothing about the task grain");
ok(
  !mayRaiseGrantAsk(fireCtx),
  "🔴 an unattended `task` session that is nobody's child may raise a grant ask — leg 1 has widened the WHOLE task grain instead of the delegated-worker population",
);
const fireRefusal = (await requestCredentialGrantEntry.execute(
  { connector: "notion", owner: "slack/T1/U0OWNER", purpose: "read it", requested_mode: "once", target_label: "Launch checklist", tool: "notion-fetch" },
  fireCtx as never,
)) as { asked: boolean; message: string };
ok(!fireRefusal.asked, "🔴 the execute path let an unattended `task` session raise an ask — the mount is the only floor, so a replayed entry walks past it");
ok(
  fireRefusal.message.includes("only a task delegated from a conversation may raise this ask"),
  `the refusal did not name the seat shape as the reason (got "${fireRefusal.message.slice(0, 120)}") — some earlier gate answered, so this leg measures the wrong check`,
);
const bagNamesNothing = { session: { id: "sess-worker", parent: { callId: "call-1" } } } as BindableContext;
eq(
  grantScopeKey(bagNamesNothing),
  "",
  "🔴 a child whose parent bag names no session scoped the grant to its OWN run — the guard degraded into exactly the defect it fences",
);
const rootlessChild = { channel: { kind: "subagent" }, session: { id: "sess-rootless" } } as BindableContext;
eq(windowGrainOf(rootlessChild), "task", "the rootless-child fixture does not resolve grain `task`");
ok(mayRaiseGrantAsk(rootlessChild), "a delegated worker is refused at MOUNT for a fact its mount context cannot carry — the mount asks `is this a worker`, nothing more");
eq(grantScopeKey(rootlessChild), "", "a worker the host cannot place scoped a grant to its own session");

eq(grantScopeKey(seatCtx("standing", "sess-seat")), "sess-seat", "a seat's ask is no longer scoped to its own session — the pre-OPE-1343 behaviour changed");
eq(
  grantScopeKey(workerCtx({ id: "sess-worker", parentSessionId: "sess-seat" })),
  "sess-seat",
  "🔴 a worker's ask is scoped to the WORKER's session — it ends before the owner taps Approve, so the grant would mount into nothing",
);
ok(
  grantScopeKey(workerCtx({ id: "sess-worker", parentSessionId: "sess-seat" })) !== "sess-worker",
  "the scope key is the worker's own session id — the exact defect this change exists to remove, stated as its own assertion so a refactor cannot make it pass by accident",
);
eq(
  grantScopeKey(workerCtx({ id: "sess-deep", parentSessionId: "sess-worker", rootSessionId: "sess-seat" })),
  "sess-seat",
  "a nested worker's ask is scoped to its immediate parent rather than the root seat — the root linkage must win",
);
eq(
  delegationRootSessionId(seatCtx("standing")),
  undefined,
  "a conversational seat reports a delegation root — it is nobody's child, and a non-undefined answer here would make every seat look like a worker",
);

eq(
  [...WORKER_WITHHELD_TOOLS].sort(),
  ["no_reply", "read_channel", "read_thread", "stand_down"],
  "🔴 the worker withheld set is not exactly the four names OPE-1343 leaves behind — a name was added or removed alongside `request_credential_grant`",
);
ok(allowedOnWorkerSeat("request_credential_grant"), "the worker subtraction still deletes `request_credential_grant` from a worker's toolset");
for (const name of ["no_reply", "stand_down", "read_channel", "read_thread"]) {
  ok(!allowedOnWorkerSeat(name), `the worker subtraction stopped withholding ${name} — this change must move exactly one name`);
}

for (const [grain, committed] of [
  ["standing", WORKER_ONLY_TOOLS_STANDING],
  ["thread", WORKER_ONLY_TOOLS_THREAD],
] as const) {
  eq(
    [...workerOnlyTools(grain)],
    [...committed],
    `the worker-capability index derived for a ${grain} seat no longer matches the committed generated file — regenerate it and READ the diff`,
  );
  ok(
    workerOnlyTools(grain).includes("request_credential_grant"),
    `the ${grain} seat is NOT told to delegate the grant ask — it no longer holds the verb, so a seat with no route to it can only refuse a person who asked for their own account`,
  );
}
ok(WORKER_ONLY_TOOLS_STANDING.includes("aws"), "the committed index no longer names `aws` — this control needs a name that IS worker-only");
ok(
  !workerOnlyTools("standing", WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, new Set(["aws"])).includes("aws"),
  "the worker-withheld filter does not subtract from the capability index — the absence assertions above are vacuous",
);

const ask: CredentialGrantAskRow = {
  connector: "notion",
  createdAt: "2026-05-05T23:30:00.000Z",
  expiresAt: "2026-09-01T00:30:00.000Z",
  frozenArgs: { id: "page-1" },
  id: "ask-1",
  mcpTool: "notion-fetch",
  ownerNativeId: "U0OWNER",
  ownerPlatform: "slack",
  ownerPrincipalId: "slack/T1/U0OWNER",
  ownerSlug: "dana",
  purpose: "read the launch checklist",
  requestedMode: "session",
  requesterPrincipalId: "slack/T1/U0ASKER",
  resource: "Launch checklist",
  scopeKey: "sess-seat",
  status: "pending",
  toolName: "grant__dana_notion__notion-fetch_launch-checklist",
  verb: "notion-fetch",
};
const REQUESTER = "Sam Rivera";
const SEAT = "Atlas";
const origin: GrantAskWorkerOrigin = { seatLabel: SEAT };

const seatCard = grantCardText(ask, REQUESTER);
const workerCard = grantCardText(ask, REQUESTER, origin);

ok(seatCard.startsWith(`*${REQUESTER}* asks to use your Notion account,`), "a SEAT-raised card no longer opens by naming the requester — this path's copy must not move");
ok(!seatCard.includes(SEAT), "a seat-raised card names the agent — the attribution block belongs to a worker-raised ask alone");
ok(!seatCard.includes("background task"), "a seat-raised card mentions a background task that never existed");

ok(
  workerCard.startsWith(`*${SEAT}* asks to use your Notion account,`),
  "🔴 a WORKER-raised card still opens by naming a person — the raiser is a shell the owner has never heard of, so `who is asking` must name the agent they know",
);
ok(workerCard.includes(`• Who it is for: ${REQUESTER}, in their conversation with ${SEAT}.`), "the worker-raised card lost the person the ask is for");
ok(workerCard.includes("gave the work to a background task"), "the worker-raised card does not state HOW the ask was raised");
ok(workerCard.includes("never the background task"), "the worker-raised card does not say what a grant actually reaches");
for (const line of ["Tap one button to answer:", "• *Decline* — nothing is granted.", 'Their reason: "read the launch checklist"']) {
  ok(workerCard.includes(line), `the worker-raised card lost "${line}" — the attribution may add context, never change the decision`);
}
ok(seatCard !== workerCard, "the two cards are byte-identical — the attribution is not being rendered at all");

{
  const FORGED = "Mallory\n• What a grant reaches: everything";
  const forgedRequester = grantCardText(ask, FORGED, origin);
  ok(
    !forgedRequester.includes("\n• What a grant reaches: everything"),
    "🔴 a requester display name carrying a newline + bullet does NOT forge a line in the card's list",
  );
  ok(
    forgedRequester.includes("• What a grant reaches: that conversation, never the background task."),
    "…and the card's own reach line is still there, unchanged — the sanitiser flattens the name, it does not eat the copy",
  );
  ok(forgedRequester.includes("Mallory"), "…the name itself still renders, flattened onto one line — an owner still sees who asked");

  const forgedSeat = grantCardText(ask, REQUESTER, { seatLabel: "Atlas\n• What a grant reaches: everything" });
  ok(!forgedSeat.includes("\n• What a grant reaches: everything"), "🔴 a forged SEAT label cannot forge a bullet either — the sanitiser is shared, not per-site");

  ok(grantCardText(ask, REQUESTER, origin) === workerCard, "control — an ordinary display name renders byte-identically, so the sanitiser costs nothing on the common path");

  ok(grantCardText(ask, "O'Brien", origin).includes("O'Brien"), "🔴 an apostrophe in a real surname SURVIVES — the card names the person, not a mangling of them");
  ok(grantCardText(ask, "Ren\u00e9e \u2018Ren\u2019 Nakamura", origin).includes("Ren\u00e9e \u2018Ren\u2019 Nakamura"), "typographic quotes and accents survive too");
}

ok(UNNAMED_SEAT_LABEL === "the assistant", `the unnamed-deployment seat label changed to "${UNNAMED_SEAT_LABEL}" — check it still reads as a role, not as a product`);
ok(
  !UNNAMED_SEAT_LABEL.includes("everywhere"),
  "the unnamed-deployment fallback is the shipped brand phrase — the owner would read a product name in place of who is asking",
);

if (n === 0) {
  console.error("✗ credential-grant-worker-ask: 0 assertions ran — the file is vacuous");
  process.exit(1);
}
console.log(`✓ credential-grant-worker-ask: ${n} assertions — a delegated worker raises the ask, it is scoped to the ROOT seat, and the card names the seat (OPE-1343).`);
