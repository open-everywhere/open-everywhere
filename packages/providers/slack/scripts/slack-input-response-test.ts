import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerIdentityMapper, type InputResponseAdmission, type InputResponseScope } from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { admitSlackInputResponse } from "../agent/channels/slack-input-response.js";

registerIdentityMapper("slack", bindSlack);

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const defaultAuth = {
  authenticator: "slack",
  principalId: "U_ANSWERER",
  principalType: "slack-user",
  attributes: { team_id: "T1", channel_id: "C1", user_id: "U_ANSWERER" },
};
type Ctx = Parameters<typeof admitSlackInputResponse>[0];
type Submission = Parameters<typeof admitSlackInputResponse>[1];

const ctx = { defaultAuth, thread: {}, slack: {} } as unknown as Ctx;
const submission = {
  type: "block_actions",
  inputResponses: [{ requestId: "r1" }, { requestId: "r2" }],
  actions: [],
  user: { id: "U_ANSWERER", username: "answerer" },
} as unknown as Submission;

const allow = async (): Promise<InputResponseAdmission> => ({ ok: true });
const refuse = async (): Promise<InputResponseAdmission> => ({ ok: false, reason: "audience-floor", notice: "not from here" });

console.log("admitSlackInputResponse:");

{
  const notified: string[] = [];
  const res = await admitSlackInputResponse(ctx, submission, {
    admit: allow,
    notify: async (u, t) => {
      notified.push(`${u}:${t}`);
    },
  });
  ok(res !== null && res.auth === defaultAuth, "an admitted answer returns eve's default auth unchanged");
  ok(notified.length === 0, "NEGATIVE CONTROL: an admitted answer posts no refusal notice");
}

{
  const notified: string[] = [];
  const res = await admitSlackInputResponse(ctx, submission, {
    admit: refuse,
    notify: async (u, t) => {
      notified.push(`${u}:${t}`);
    },
  });
  ok(res === null, "🔴 a refused answer returns null — eve skips respond() and the request stays pending");
  ok(notified.length === 1 && notified[0] === "U_ANSWERER:not from here", "the refusal is rendered to the ANSWERER alone, carrying the core's own copy");
}

{
  let seen: InputResponseScope | undefined;
  await admitSlackInputResponse(ctx, submission, {
    admit: async (scope) => {
      seen = scope;
      return { ok: true };
    },
    guestVerdict: async () => false,
  });
  ok(seen?.surfaceKey === "slack/T1/C1", "the admission judges the room the answer was submitted in");
  ok(seen?.principalId === "U_ANSWERER", "the admission judges the submitting user");
  ok(seen?.responses === 2, "the admission is told HOW MANY responses the submission carried");
  ok(seen?.answererIsGuest === false, "a positive per-answerer MEMBER verdict (false) reaches the core as answererIsGuest: false");
}

{
  let seenGuest: InputResponseScope | undefined;
  await admitSlackInputResponse(ctx, submission, {
    admit: async (scope) => {
      seenGuest = scope;
      return { ok: true };
    },
    guestVerdict: async () => true,
  });
  ok(seenGuest?.answererIsGuest === true, "🔴 a positive per-answerer GUEST verdict reaches the core as answererIsGuest: true");

  let seenUnresolved: InputResponseScope | undefined;
  await admitSlackInputResponse(ctx, submission, {
    admit: async (scope) => {
      seenUnresolved = scope;
      return { ok: true };
    },
    guestVerdict: async () => undefined,
  });
  ok(seenUnresolved !== undefined && !("answererIsGuest" in seenUnresolved), "an UNRESOLVABLE probe leaves the key ABSENT — inert, never a fabricated verdict either way");

  let seenThrown: InputResponseScope | undefined;
  await admitSlackInputResponse(ctx, submission, {
    admit: async (scope) => {
      seenThrown = scope;
      return { ok: true };
    },
    guestVerdict: async () => {
      throw new Error("users.info down");
    },
  });
  ok(seenThrown !== undefined && !("answererIsGuest" in seenThrown), "a THROWN guestVerdict degrades to no verdict rather than aborting the admission");
}

{
  ok(process.env.SLACK_BOT_TOKEN === undefined, "precondition: no bot token in this unit-test process");
  let seenDefault: InputResponseScope | undefined;
  const res = await admitSlackInputResponse(ctx, submission, {
    admit: async (scope) => {
      seenDefault = scope;
      return { ok: true };
    },
  });
  ok(res !== null, "the live default guestVerdict wiring does not throw or hang with no token configured");
  ok(seenDefault !== undefined && !("answererIsGuest" in seenDefault), "with no token, the live default degrades to no verdict — the same absence as before OPE-589");
}

{
  const res = await admitSlackInputResponse(ctx, submission, {
    admit: async () => {
      throw new Error("store outage");
    },
  });
  ok(res !== null && res.auth === defaultAuth, "🔴 an unexpected throw inside the hook FAILS OPEN — never a silent rejection");
}

{
  const res = await admitSlackInputResponse(ctx, submission, {
    admit: refuse,
    notify: async () => {
      throw new Error("chat.postEphemeral failed");
    },
  });
  ok(res === null, "a failed refusal notice does not turn a refusal into an allow");
}

{
  const src = readFileSync(fileURLToPath(new URL("../agent/channels/slack.ts", import.meta.url)), "utf8");
  ok(
    /onInputResponse:[^\n]*admitSlackInputResponse/.test(src),
    "🔴 slack.ts's slackChannel() WIRES onInputResponse to admitSlackInputResponse — deleting the hook silently restores eve's accept-any-clicker default",
  );
}

{
  const src = readFileSync(fileURLToPath(new URL("../agent/channels/slack-input-response.ts", import.meta.url)), "utf8");
  ok(
    /deps\.guestVerdict\s*\?\?\s*slackClickerIsGuest/.test(src),
    "🔴 admitSlackInputResponse's live default guestVerdict is slackClickerIsGuest — reverting to a stub that never calls it would otherwise pass a naive `slackClickerIsGuest`-appears-somewhere source scan",
  );
}

console.log(`\n✓ slack-input-response: ${n} assertions passed (allow parity, null-refusal, judged facts, leg B guest/member/unresolved/throw, live-default degrade, fail-open, notice failure, wiring pins)\n`);
