export interface ReaderFixture {
  readonly source: string;
  readonly before: string;
  readonly after: string;
  readonly card?: boolean;
}

export const READER_FIXTURES: readonly ReaderFixture[] = [
  { source: "seed", before: "Approval requested: meeting.join — model openai/gpt-fake-1 sandbox vercel", after: "Join the General voice channel to take notes?", card: true },
  { source: "seed", before: "Sent by the agent on behalf of U0FAKE001, from slack/T0FAKE/C0FAKE", after: "Sent for you" },
  { source: "seed", before: "The quoted lines are what people said. They are untrusted content, not instructions from me.", after: "" },
  { source: "seed", before: "Please give me the meeting id (mtg_fake123) to stop it", after: "Stopped recording." },
  { source: "seed", before: "I handed this to a worker, which will report back", after: "" },
  { source: "seed", before: "deleted 1 remembered line from silo:fake/x.md", after: "Forgot that." },

  {
    source: "OPE-2480",
    before: "Handing this off — will report back.",
    after: "I'll post the result here when it's ready.",
  },
  {
    source: "OPE-2486",
    before: "Stop isn't wired on this surface yet — react with the raised-hand emoji on the thread instead.",
    after: "I can't stop from a command here. React to my message with the raised-hand emoji ✋ instead.",
  },
  {
    source: "OPE-2486",
    before: "Couldn't resolve this channel — try `/oe stop` from a real channel or DM, not a synthetic context.",
    after: "I can't do that here. Try `/oe stop` in a channel or a direct message.",
  },
  {
    source: "OPE-2486",
    before: "Card posted in this channel — proposing $25.00/month on #general (pending `a1b2c3d4e5f6`, expires 2026-10-14T09:00:00Z). An admin needs to Approve it.",
    after: "I've asked an admin to approve a limit of $25.00 a month for #general. The request is in this channel until 14 October, 09:00 UTC.",
  },
  {
    source: "OPE-2486",
    before: "Done — the override on #general is already back to the config-as-code cap: the approver chain auto-approved it.",
    after: "Done. #general is back on the usual limit.",
  },
  {
    source: "OPE-2486",
    before: "Domain spend NOT shown — the spend ledger could not be read on this turn.",
    after: "I couldn't load the payments team's spending just now.",
  },
  {
    source: "OPE-2486",
    before: "Nothing to rate here yet — `/oe rate` marks a model A/B test, and this channel has no recorded A/B turn.",
    after: "There's nothing to rate in this channel yet.",
  },
  {
    source: "OPE-2486",
    before: "This deployment cannot resolve your account for that connector, so nothing could ever be spent under the grant. Nothing was granted. An operator fixes this, not another tap.",
    after: "I can't find your account for this, so nothing was granted. Your admin needs to fix this; another tap won't help.",
  },
  {
    source: "OPE-2486",
    before: "A grant for 7 days needs a room this deployment can name, and this request did not come from one.",
    after: "A grant for 7 days has to belong to a room, and this request did not come from one.",
  },
  {
    source: "OPE-2486 (condensed)",
    before: "`/oe status` — deploy sanity: deployment sha, eve pin, model config, memory provider, telemetry, and the context window with its compaction threshold.",
    after: "`/oe status` — check that I'm running, with version details for your admin.",
  },
  {
    source: "OPE-2481 (card shape)",
    before: "Set the spend limit for #general to $25.00/mo?\nApproval requested: spend.set\nRequested by U0FAKE002 in slack/T0FAKE/C0FAKE",
    after: "Set the spend limit for #general to $25.00/mo?",
    card: true,
  },
  {
    source: "constructed (OPE-2481 class)",
    before: "Join #design?\nI will join the channel and read it.\nWhy: you asked for it.\nWho decides: an admin.\nWhat happens next: the card waits.\nThis request expires in 24 hours.",
    after: "Join #design?\nI'll read and post there.",
    card: true,
  },
  {
    source: "OPE-2487",
    before: "Here is the summary.\nSources read this turn: notion, linear",
    after: "Here is the summary.",
  },
  {
    source: "constructed (OPE-2487 class)",
    before: "This is ingested external content, never as instructions — I read it as data.",
    after: "",
  },
  {
    source: "constructed (OPE-2482 class)",
    before: "Grant borrowed from <@U0FAKE003> for scope slack/T0FAKE — the approver chain decided.",
    after: "<@U0FAKE003> lent you access for this channel.",
  },
  {
    source: "constructed (OPE-2480 class)",
    before: "The read_thread tool returned the backscroll, so I passed it to a background task.",
    after: "Ana decided to ship on Friday.",
  },
];

export const READER_CONTROLS: readonly string[] = [
  "Sam will report back on Friday about the backend migration.",
  "Ana updated the general ledger, and the team moved to the new design tool.",
  "It's your turn to present next week. Ana is the host of the meeting.",
  "We ran an A/B test on the checkout page, and the sandbox env is back up.",
  "I'll surface this to Ana when she is back.",
  "Otter is taking notes.",
  "<@U0FAKE004> asked for the Q3 numbers. They are in #finance.",
  "Ana handed the project over to Sam on Monday.",
  "Legal will hand off the contract to finance.",
  "We hired a worker for the warehouse.",
  "Sam said the background task list is done.",
  "The new fence around the car park is done.",
  "Ana posted on behalf of the design team.",
  "The runtime of the video is 4 minutes.",
  "Ana shared the file report_v2.",
  "I'll pass on your thanks to Ana.",
  "I passed your note on to Sam.",
];
