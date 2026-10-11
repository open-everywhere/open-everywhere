import { inlineForReview } from "./review-surface.js";
import { plainValue } from "./plain-text.js";
import { registerActionKind } from "./actions.js";
import { grantAct, handBack } from "../personal-browser/lifecycle.js";
import type { ActionKind } from "./types.js";

export interface BrowserActArgs {
  readonly org: string;
  readonly person: string;
  readonly principalId: string;
  readonly host: string;
  readonly minutes: number;
  readonly reason?: string;
}

export interface BrowserHandbackArgs {
  readonly org: string;
  readonly person: string;
  readonly principalId: string;
  readonly reason: string;
}

function ownerOnly(principalId: string, decidedBy: string): void {
  if (decidedBy !== principalId) throw new Error("only the person whose browser this is can decide this, by their own click — an automatic approval (a config rule, the judge or a bypass) does not count");
}

export function browserActSummary(args: BrowserActArgs): string[] {
  return [
    `Let me click, type and choose options on ${inlineForReview(args.host)} in your own browser, for the next ${args.minutes} minutes.`,
    "You are signed in there, so I can submit forms and change things in your account on that site.",
    "I can't type into password, one-time-code or card fields: you type those yourself after you take the controls.",
    "Every action I take writes an audit row with the site and the kind of action, never what I typed.",
    ...(args.reason ? [`Why: ${inlineForReview(args.reason)}`] : []),
  ];
}

const browserAct: ActionKind<BrowserActArgs> = {
  kind: "browser.personal.act",
  policy: "member",
  proseArgs: ["reason"],
  summarize: browserActSummary,
  plainSummary(args) {
    return `Let the agent click and type on ${plainValue(args.host)} in your own browser for ${args.minutes} minutes`;
  },
  async execute(args, decidedBy) {
    ownerOnly(args.principalId, decidedBy);
    const until = await grantAct(args.org, args.person, args.host, args.minutes, decidedBy);
    return `the agent may click and type on ${args.host} in your browser until ${new Date(until).toISOString().slice(11, 16)} UTC`;
  },
};

export function browserHandbackSummary(args: BrowserHandbackArgs): string[] {
  return [
    `You have the controls of your browser: ${inlineForReview(args.reason)}`,
    "Open it from the link I sent you in this DM. I'm not touching the browser while you have the controls.",
    "When you're done, approve this card to give the controls back to me, and I'll carry on from the page you left.",
  ];
}

const browserHandback: ActionKind<BrowserHandbackArgs> = {
  kind: "browser.personal.handback",
  policy: "member",
  proseArgs: ["reason"],
  summarize: browserHandbackSummary,
  plainSummary() {
    return "Give the controls of your browser back to the agent";
  },
  async execute(args, decidedBy) {
    ownerOnly(args.principalId, decidedBy);
    const changed = await handBack(args.org, args.person, "card");
    return changed ? "the controls are back with the agent; it carries on from the page you left" : "the agent already had the controls";
  },
};

registerActionKind(browserAct);
registerActionKind(browserHandback);
