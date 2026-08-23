import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InputResponseAdmission, InputResponseScope } from "@open-everywhere/core/agent/adapter-api.js";
import { registerTeamsProvider } from "../agent/register.js";
import { admitTeamsInputResponse } from "../agent/channels/teams-input-response.js";

registerTeamsProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

type Ctx = Parameters<typeof admitTeamsInputResponse>[0];
type Activity = Parameters<typeof admitTeamsInputResponse>[1];

const ctx = { teams: { request: async () => ({ ok: false, body: {} }) }, thread: {} } as unknown as Ctx;
const activity = {
  type: "invoke",
  name: "adaptiveCard/action",
  id: "a1",
  from: { id: "29:answerer", name: "Answerer", aadObjectId: "aad-1" },
  recipient: { id: "28:bot" },
  conversation: { id: "19:conv@thread.tacv2", tenantId: "tenant-1" },
  serviceUrl: "https://smba.trafficmanager.net/uk/",
  tenantId: "tenant-1",
  teamId: "19:team@thread.tacv2",
  teamsChannelId: "19:chan@thread.tacv2",
  scope: "channel",
  channelData: {},
  raw: {},
} as unknown as Activity;

const allow = async (): Promise<InputResponseAdmission> => ({ ok: true, floor: "member" });
const refuse = async (): Promise<InputResponseAdmission> => ({ ok: false, reason: "guest-answerer", notice: "you are a guest" });

console.log("admitTeamsInputResponse:");

{
  const posted: string[] = [];
  const res = await admitTeamsInputResponse(ctx, activity, {
    admit: allow,
    userType: async () => "member",
    notify: async (t) => {
      posted.push(t);
    },
  });
  ok(res !== null && res.auth !== null && res.auth.principalId === "29:answerer", "an admitted answer returns OE's own Teams auth for the answerer");
  ok(res !== null && res.auth !== null && res.auth.attributes?.tenant_id === "tenant-1", "the returned auth carries the real tenant, not an env stand-in");
  ok(posted.length === 0, "NEGATIVE CONTROL: an admitted answer posts no refusal notice");
}

{
  const posted: string[] = [];
  const res = await admitTeamsInputResponse(ctx, activity, {
    admit: refuse,
    userType: async () => "guest",
    notify: async (t) => {
      posted.push(t);
    },
  });
  ok(res === null, "🔴 a refused answer returns null — eve skips respond() and the request stays pending");
  ok(posted.length === 1 && posted[0] === "you are a guest", "the refusal carries the core's own copy");
}

{
  const seen: (InputResponseScope | undefined)[] = [];
  const capture = async (scope: InputResponseScope): Promise<InputResponseAdmission> => {
    seen.push(scope);
    return { ok: true, floor: "member" };
  };
  await admitTeamsInputResponse(ctx, activity, { admit: capture, userType: async () => "guest" });
  await admitTeamsInputResponse(ctx, activity, { admit: capture, userType: async () => "member" });
  await admitTeamsInputResponse(ctx, activity, { admit: capture, userType: async () => undefined });
  ok(seen[0]?.answererIsGuest === true, "🔴 an observed GUEST reaches the decision as answererIsGuest: true");
  ok(seen[1]?.answererIsGuest === false, "an observed MEMBER reaches the decision as answererIsGuest: false");
  ok(seen[2] !== undefined && !("answererIsGuest" in seen[2]), "🔴 an UNRESOLVABLE probe leaves the key ABSENT — inert, never a fabricated verdict either way");
  ok(seen[0]?.principalId === "29:answerer", "the admission judges the submitting Teams user");
  ok(typeof seen[0]?.surfaceKey === "string" && seen[0].surfaceKey.startsWith("teams/"), "the admission judges the Teams room the answer was submitted in");
}

{
  const thrownAdmit = await admitTeamsInputResponse(ctx, activity, {
    admit: async () => {
      throw new Error("store outage");
    },
    userType: async () => "member",
  });
  ok(thrownAdmit !== null, "🔴 a thrown admission FAILS OPEN — never back to the silent drop");
  const thrownProbe = await admitTeamsInputResponse(ctx, activity, {
    admit: allow,
    userType: async () => {
      throw new Error("connector 503");
    },
  });
  ok(thrownProbe !== null, "🔴 a thrown member probe FAILS OPEN — a roster blip must not make questions unanswerable");
}

{
  const res = await admitTeamsInputResponse(ctx, activity, {
    admit: refuse,
    userType: async () => "guest",
    notify: async () => {
      throw new Error("post failed");
    },
  });
  ok(res === null, "a failed refusal notice does not turn a refusal into an allow");
}

{
  let seenSpend: { door?: string; principalId?: string } | undefined;
  const res = await admitTeamsInputResponse(ctx, activity, {
    admit: allow,
    userType: async () => "member",
    spendGate: async (input) => {
      seenSpend = { door: input.door, principalId: input.principalId };
      return "proceed";
    },
  });
  ok(res !== null && res.auth !== null && res.auth.principalId === "29:answerer", "an under-cap resume proceeds to the room/guest admission");
  ok(seenSpend?.door === "answer", "🔴 the spend gate is consulted with its own door (\"answer\")");
  ok(seenSpend?.principalId === "29:answerer", "the spend gate judges the submitting Teams user as principal");
}

{
  let admitCalled = false;
  let userTypeCalled = false;
  const posted: string[] = [];
  const ctxWithPost = { teams: { request: async () => ({ ok: false, body: {} }) }, thread: { post: async (t: string) => { posted.push(t); } } } as unknown as Ctx;
  const res = await admitTeamsInputResponse(ctxWithPost, activity, {
    admit: async () => {
      admitCalled = true;
      return { ok: true, floor: "member" };
    },
    userType: async () => {
      userTypeCalled = true;
      return "member";
    },
    spendGate: async (input) => {
      await input.post("over cap, holding off");
      return "declined";
    },
  });
  ok(res === null, "🔴 a DECLINED spend gate returns null — the same as a room/guest refusal");
  ok(!admitCalled, "🔴 a declined spend gate short-circuits BEFORE the room/guest admission runs");
  ok(userTypeCalled, "the member probe still ran (it builds the auth the gate itself needs)");
  ok(
    posted.length === 1 && posted[0] === "over cap, holding off",
    "the spend gate's own post callback reaches the answerer through ctx.thread.post, the same channel the room/guest refusal uses",
  );
}

{
  const src = readFileSync(fileURLToPath(new URL("../agent/channels/teams.ts", import.meta.url)), "utf8");
  ok(
    /onInputResponse:[^\n]*admitTeamsInputResponse/.test(src),
    "🔴 teams.ts's teamsChannel() WIRES onInputResponse to admitTeamsInputResponse — deleting the hook silently restores eve's rejectInput, which drops every answer",
  );
  ok(/onMessage:\s*teamsOnMessage/.test(src), "teams.ts still authors onMessage — the fact that makes eve's omitted-hook default `rejectInput` rather than accept-any");
}

{
  const src = readFileSync(fileURLToPath(new URL("../agent/channels/teams-input-response.ts", import.meta.url)), "utf8");
  ok(
    /deps\.spendGate\s*\?\?\s*ingressSpendGate/.test(src),
    "🔴 admitTeamsInputResponse's live default spendGate is ingressSpendGate — reverting to a stub that never gates would otherwise pass a naive \"ingressSpendGate appears somewhere\" source scan",
  );
  ok(/door:\s*"answer"/.test(src), "🔴 the spend gate is consulted with its own door (\"answer\"), not silently folded into an existing one");
}

console.log(`\n✓ teams-input-response: ${n} assertions passed (allow parity, null-refusal, leg-B verdict polarity, fail-open, notice failure, spend gate first + negative control, wiring pins)\n`);
