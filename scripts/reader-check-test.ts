import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIPPED_STACK, STACKS } from "../agent/model/stacks.js";
import { READER_CONTROLS, READER_FIXTURES } from "../packages/core/scripts/e2e/reader-fixtures.js";
import { READER_RULES, READER_RULINGS, cardRepeatHits, readerHits, readerJudgePrompt, visibleWords } from "../packages/core/scripts/e2e/reader-rubric.js";
import {
  PostedTextCollector,
  READER_JUDGE_MODEL,
  READER_MAX_TEXTS_PER_LEG,
  agentMessageOf,
  buildReaderJudgeUser,
  calibrateReaderJudge,
  llmReaderJudge,
  parseReaderJudgeResponse,
  renderReaderReport,
  resolveReaderJudge,
  reviewPostedTexts,
  wrapDriver,
  wrapScenarioDrivers,
  type ReaderJudge,
  type ReaderJudgeFlag,
} from "../packages/core/scripts/e2e/reader-check.js";
import type { ReaderText } from "../packages/core/scripts/e2e/reader-rubric.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

{
  ok(READER_FIXTURES.length >= 20, `§1 the fixture list carries the six seeds and the sweep's strings (got ${READER_FIXTURES.length})`);
  const firedBy = new Set<string>();
  for (const f of READER_FIXTURES) {
    const hits = readerHits({ text: f.before, ...(f.card ? { card: true } : {}) });
    ok(hits.length > 0, `§1 the known-bad string flags: ${JSON.stringify(f.before)}`);
    for (const h of hits) firedBy.add(h.rule);
    if (f.after) {
      const good = readerHits({ text: f.after, ...(f.card ? { card: true } : {}) });
      ok(good.length === 0, `§1 the rewrite passes: ${JSON.stringify(f.after)} (flagged: ${JSON.stringify(good)})`);
    }
  }
  for (const rule of READER_RULES) ok(firedBy.has(rule.id), `§1 rule \`${rule.id}\` flags at least one fixture — a rule no fixture exercises can rot into a no-op`);
  for (const f of READER_FIXTURES) {
    for (const id of `${f.before} ${f.after}`.match(/\b[UCTW][A-Z0-9]{8,}\b/g) ?? []) ok(/FAKE/.test(id), `§1 the fixture id ${id} is visibly fake`);
  }
  for (const r of READER_RULINGS) {
    for (const id of r.text.match(/\b[UCTW][A-Z0-9]{8,}\b/g) ?? []) ok(/FAKE/.test(id), `§1 the ruling ${r.id} example id ${id} is visibly fake`);
  }
  const rulingIds = new Set(READER_RULINGS.map((r) => r.id));
  for (const rule of READER_RULES) ok(rulingIds.has(rule.ruling), `§1 rule \`${rule.id}\` cites a real ruling (${rule.ruling})`);
  ok(READER_RULINGS.length === 6, "§1 the rubric carries the six reader rulings");
  for (const c of READER_CONTROLS) {
    const hits = readerHits({ text: c });
    ok(hits.length === 0, `§1 room news passes: ${JSON.stringify(c)} (flagged: ${JSON.stringify(hits)})`);
  }
  ok(readerHits({ text: "<https://example.slack.com/team/U0FAKE009|Ana Diaz> (ana@example.com)" }).length === 0, "§1 R5: a raw id inside the profile URL is not a fault");
  ok(visibleWords("<https://x.example/U0FAKE009|Ana>").includes("Ana"), "§1 a link's label stays visible");
}

{
  const unflagged = READER_FIXTURES.filter((f) => readerHits({ text: f.before, ...(f.card ? { card: true } : {}) }, []).length === 0);
  ok(unflagged.length === READER_FIXTURES.length, "§2 with no rules, EVERY known-bad string passes — so §1's flags come from the rubric and nothing else");
  const review = await reviewPostedTexts(
    READER_FIXTURES.map((f) => ({ leg: "L", text: f.before })),
    { rules: [] },
  );
  ok(review.flags.length === 0, "§2 the review over the fixtures with no rules raises no flag (the card-repeat rule goes with the rubric)");
}

{
  const prompt = readerJudgePrompt();
  for (const r of READER_RULINGS) ok(prompt.includes(r.text), `§3 the judge prompt carries ruling ${r.id} verbatim`);
  ok(/STRICT JSON/.test(prompt) && /"flags"/.test(prompt), "§3 the judge prompt states the output contract");
  const user = buildReaderJudgeUser([{ text: "Hi" }, { text: "Join #design?", card: true }, { text: "x".repeat(5_000) }]);
  ok(user.includes("MESSAGE 1:\nHi") && user.includes("MESSAGE 2 (a card with buttons):"), "§3 the texts are numbered from 1 and a card says so");
  ok(user.length < 2_000, "§3 a long text is cut before the judge reads it");

  ok(JSON.stringify(parseReaderJudgeResponse('{"flags":[]}', 2)) === "[]", "§3 an empty flag list parses");
  const one = parseReaderJudgeResponse('noise {"flags":[{"item":2,"ruling":"R3","quote":"mtg_x1","why":"raw id"}]} tail', 2);
  ok(one?.length === 1 && one[0]!.item === 2 && one[0]!.quote === "mtg_x1", "§3 a flag parses out of surrounding noise");
  ok(parseReaderJudgeResponse("no json here", 2) === null, "§3 no object → null");
  ok(parseReaderJudgeResponse("{not json}", 2) === null, "§3 bad JSON → null");
  ok(parseReaderJudgeResponse('{"flag":[]}', 2) === null, "§3 a missing `flags` array → null");
  ok(parseReaderJudgeResponse('{"flags":[{"item":3,"quote":"x"}]}', 2) === null, "§3 an item outside the batch → null");
  ok(parseReaderJudgeResponse('{"flags":[{"item":1}]}', 2) === null, "§3 a flag with no quote → null");
}

function fakeJudge(opts: { miss?: string; falseFlag?: string; throws?: boolean; calls?: { n: number } } = {}): ReaderJudge {
  return {
    name: "fake",
    review(items: readonly ReaderText[]): Promise<readonly ReaderJudgeFlag[]> {
      if (opts.calls) opts.calls.n++;
      if (opts.throws) return Promise.reject(new Error("gateway HTTP 503"));
      const out: ReaderJudgeFlag[] = [];
      items.forEach((it, i) => {
        if (opts.falseFlag !== undefined && it.text === opts.falseFlag) out.push({ item: i + 1, ruling: "LONG", quote: it.text, why: "fake" });
        if (opts.miss !== undefined && it.text === opts.miss) return;
        if (readerHits(it).length > 0) out.push({ item: i + 1, ruling: "R3", quote: it.text.slice(0, 20), why: "judge saw it" });
      });
      return Promise.resolve(out);
    },
  };
}

{
  const good = await calibrateReaderJudge(fakeJudge());
  ok(good.trusted && /passed all \d+ of its fixtures/.test(good.detail), `§4 a judge that flags every before and no after is trusted (${good.detail})`);
  const miss = READER_FIXTURES[3]!.before;
  const missed = await calibrateReaderJudge(fakeJudge({ miss }));
  ok(!missed.trusted && missed.detail.includes("missed 1") && missed.detail.includes(miss.slice(0, 30)), `§4 one missed before leaves the judge untrusted and names it (${missed.detail})`);
  const goodAfter = READER_FIXTURES[0]!.after;
  const flagged = await calibrateReaderJudge(fakeJudge({ falseFlag: goodAfter }));
  ok(!flagged.trusted && flagged.detail.includes("flagged 1 good rewrite"), `§4 a flag on a good rewrite leaves the judge untrusted (${flagged.detail})`);
  const down = await calibrateReaderJudge(fakeJudge({ throws: true }));
  ok(!down.trusted && down.detail.includes("gateway HTTP 503"), "§4 a failed call leaves the judge untrusted, never throws, and says why");
  const garbage = await calibrateReaderJudge(llmReaderJudge(() => Promise.resolve("sure, looks fine"), "fake/model"));
  ok(!garbage.trusted && garbage.detail.includes("unparseable"), "§4 an unparseable judge answer fails calibration");
  ok(resolveReaderJudge({}) === undefined, "§4 with no AI_GATEWAY_API_KEY there is no judge (the rules still run)");
}

{
  const texts = [
    { leg: "S-A", text: "Done. #general is back on the usual limit." },
    { leg: "S-A", text: "Please give me the meeting id (mtg_fake123) to stop it" },
    { leg: "S-B", text: "Please give me the meeting id (mtg_fake123) to stop it" },
  ];
  const rulesOnly = await reviewPostedTexts(texts);
  ok(rulesOnly.texts === 3 && rulesOnly.legs === 2, "§5 the review counts texts and legs");
  ok(rulesOnly.flags.every((f) => f.rule !== "judge") && rulesOnly.flags.some((f) => f.leg === "S-B" && f.quote === "mtg_fake123"), "§5 with no judge, the rules flag on every leg that posted the text");
  ok(/rules only — no AI_GATEWAY_API_KEY/.test(rulesOnly.graders), "§5 the graders line says the judge did not run, and why");

  const calls = { n: 0 };
  const trusted = await reviewPostedTexts(texts, { judge: fakeJudge({ calls }), calibration: { trusted: true, detail: "fake passed" } });
  ok(trusted.flags.some((f) => f.rule === "judge" && f.leg === "S-B"), "§5 a trusted judge's flags join the report, on each leg");
  ok(calls.n === 1, `§5 a text already read is not sent again: two legs, one call (got ${calls.n})`);

  const untrusted = await reviewPostedTexts(texts, { judge: fakeJudge(), calibration: { trusted: false, detail: "fake missed 2" } });
  ok(untrusted.flags.every((f) => f.rule !== "judge") && untrusted.graders.includes("fake missed 2"), "§5 an untrusted judge contributes NO flag, and the graders line says why");

  const failing = await reviewPostedTexts(texts, { judge: fakeJudge({ throws: true }), calibration: { trusted: true, detail: "ok" } });
  ok(failing.flags.length === rulesOnly.flags.length && /2 failed/.test(failing.graders), "§5 a failed judge call keeps the rule flags and is counted");

  let clock = 0;
  const deadlineCalls = { n: 0 };
  const late = await reviewPostedTexts(texts, {
    judge: fakeJudge({ calls: deadlineCalls }),
    calibration: { trusted: true, detail: "ok" },
    deadlineMs: 10,
    now: () => (clock += 20),
  });
  ok(deadlineCalls.n === 0 && /past the deadline/.test(late.graders) && late.flags.length === rulesOnly.flags.length, "§5 past the deadline the judge is not called, the line says so, and the rule flags stand");

  const empty = await reviewPostedTexts([]);
  ok(empty.texts === 0 && empty.flags.length === 0 && empty.graders.startsWith("nobody"), "§5 nothing posted: nothing read, and the line says so");

  const card = { text: "*Set the spend limit for #general to $25.00/mo?*\nAn admin decides.", card: true };
  const repeat = { text: "I asked to set the spend limit for #general to $25.00/mo — tap Approve." };
  ok(cardRepeatHits([card, repeat]).length === 1 && cardRepeatHits([card, repeat])[0]!.index === 1, "§5 card-repeat: a message that repeats the card's headline flags");
  ok(cardRepeatHits([card, { text: "Done." }]).length === 0, "§5 card-repeat: a message that does not repeat it passes");
  ok(cardRepeatHits([repeat]).length === 0, "§5 card-repeat: with no card there is nothing to repeat");
  const legReview = await reviewPostedTexts([{ leg: "S-CARD", ...card }, { leg: "S-CARD", ...repeat }]);
  ok(legReview.flags.some((f) => f.rule === "card-repeat" && f.ruling === "R6"), "§5 the review runs card-repeat per leg");
  const crossLeg = await reviewPostedTexts([{ leg: "S-1", ...card }, { leg: "S-2", ...repeat }]);
  ok(!crossLeg.flags.some((f) => f.rule === "card-repeat"), "§5 card-repeat reads one leg at a time: another leg's card is not this conversation");
}

{
  const none = renderReaderReport({ flags: [], texts: 4, legs: 2, graders: "rules only — x" });
  ok(none[0] === "## Reader check" && none.length === 3 && none[2]!.includes("0 flag(s)") && none[2]!.includes("never a red"), "§6 a clean run prints the heading and one count line that says flags never gate");
  const rows = renderReaderReport({
    flags: [{ leg: "S-PIPE", ruling: "R3", rule: "prefixed-id", quote: "a | b", why: "a prefixed raw id", excerpt: "x\ny" }],
    texts: 1,
    legs: 1,
    graders: "rules only — x",
  });
  ok(rows.includes("| Leg | Ruling | Quote | Why | In |"), "§6 flags render as a table with the leg and the quote");
  ok(rows.some((r) => r.startsWith("| S-PIPE | R3 | a \\| b |")), "§6 a pipe in a quote is escaped, so it cannot split the row");
  ok(rows.every((r) => !r.includes("\n")), "§6 a newline in an excerpt cannot break the table");
}

{
  ok(agentMessageOf({ ts: "1.1", text: "hi there", botId: "B0FAKE" })?.text === "hi there", "§7 Slack: a bot message is the agent's");
  ok(agentMessageOf({ ts: "1.2", text: "hi there", userId: "U0FAKE1" }) === undefined, "§7 Slack: a person's message is not");
  const slackCard = agentMessageOf({ ts: "1.3", text: "fallback", botId: "B0FAKE", blockTexts: ["*Join #design?*", "I'll read it."], actions: [{ actionId: "approve" }] });
  ok(slackCard?.card === true && slackCard.text === "*Join #design?*\nI'll read it.", "§7 Slack: a card reads as its visible block lines, and is a card");
  ok(agentMessageOf({ id: "9", content: "ok then", authorIsBot: true, components: [] })?.key === "discord:9", "§7 Discord: a bot-authored message is the agent's");
  ok(agentMessageOf({ id: "9", content: "ok then", authorIsBot: false, components: [] }) === undefined, "§7 Discord: a person's message is not");
  ok(agentMessageOf({ id: "t1", text: "done", fromApplicationId: "app" })?.key === "teams:t1", "§7 Teams: an app-authored message is the agent's");
  ok(agentMessageOf({ id: 7, body: "PR opened", authorType: "Bot", authorLogin: "oe[bot]" })?.key === "github:7", "§7 GitHub: a bot comment is the agent's");
  ok(agentMessageOf({ id: 7, body: "PR opened", authorType: "User", authorLogin: "ana" }) === undefined, "§7 GitHub: a person's comment is not");
  const app = new Set(["app-1"]);
  ok(agentMessageOf({ id: "l1", body: "Done.", userId: "app-1", userDisplayName: "OE", createdAt: "" }, app)?.key === "linear:l1", "§7 Linear: a comment by the driver's app user is the agent's");
  ok(agentMessageOf({ id: "l2", body: "Done.", userId: "person-1", userDisplayName: "Ana", createdAt: "" }, app) === undefined, "§7 Linear: a person's comment is not");
  ok(agentMessageOf({ id: "n1", discussionId: "d", authorId: "app-1", text: "Done.", createdTime: "" }, app)?.key === "notion:n1", "§7 Notion: a comment by the driver's bot user is the agent's");
  ok(agentMessageOf({ id: "n1", discussionId: "d", authorId: "app-1", text: "Done.", createdTime: "" }) === undefined, "§7 Notion: with no agent id known, nothing counts");

  const c = new PostedTextCollector("S-X", "slack");
  c.harvest([{ ts: "1", text: "first", botId: "B" }, { ts: "2", text: "a person", userId: "U" }]);
  c.harvest({ messages: [{ ts: "3", text: "nested", botId: "B" }] });
  c.harvest({ ts: "1", text: "first, edited", botId: "B" });
  ok(JSON.stringify(c.texts().map((t) => t.text)) === JSON.stringify(["first, edited", "nested"]), "§7 the collector keeps the agent's messages, reads a nested list, and an edit replaces the text");
  ok(c.texts().every((t) => t.leg === "S-X" && t.surface === "slack"), "§7 every text carries its leg");
  c.noteHarnessText("please summarise the thread for me");
  c.harvest({ ts: "4", text: "please summarise the thread for me", botId: "B" });
  ok(!c.texts().some((t) => t.text.startsWith("please summarise")), "§7 the harness's own words are never graded as the agent's");
  c.add("Notion comment text", { card: false });
  ok(c.texts().some((t) => t.text === "Notion comment text"), "§7 a leg can hand in text no driver returned");
  const big = new PostedTextCollector("S-BIG");
  for (let i = 0; i < READER_MAX_TEXTS_PER_LEG + 10; i++) big.harvest({ ts: String(i), text: `m${i}`, botId: "B" });
  ok(big.texts().length === READER_MAX_TEXTS_PER_LEG, "§7 one leg keeps at most the cap");

  class FakeDriver {
    #token = "secret";
    posted: string[] = [];
    async post(text: string): Promise<{ ts: string }> {
      this.posted.push(text);
      return { ts: this.#token.length.toString() };
    }
    async replies(): Promise<readonly unknown[]> {
      return [{ ts: "9", text: "Stopped recording.", botId: "B" }, { ts: "10", text: "check the board", botId: "B" }];
    }
    sync(): { ts: string; text: string; botId: string } {
      return { ts: "11", text: "sync reply", botId: "B" };
    }
    withChannel(): FakeDriver {
      return new FakeDriver();
    }
  }
  class FakeLinear {
    get appUserId(): string {
      return "app-9";
    }
    async replies(): Promise<readonly unknown[]> {
      return [{ id: "c1", body: "Filed it as a ticket.", userId: "app-9", userDisplayName: "OE", createdAt: "" }, { id: "c2", body: "thanks", userId: "u", userDisplayName: "Ana", createdAt: "" }];
    }
  }
  const real = new FakeDriver();
  const col = new PostedTextCollector("S-PROXY");
  const wrapped = wrapDriver(real, col);
  const posted = await wrapped.post("check the board");
  ok(posted.ts === "6" && real.posted[0] === "check the board", "§7 a wrapped call runs on the real driver, private field and all, and returns its result unchanged");
  ok(wrapped instanceof FakeDriver, "§7 a wrapped driver is still an instance of its class");
  await wrapped.replies();
  wrapped.sync();
  ok(JSON.stringify(col.texts().map((t) => t.text)) === JSON.stringify(["Stopped recording.", "sync reply"]), "§7 a wrapped driver harvests its replies, sync and async, minus the harness's own post");
  const reboundCol = new PostedTextCollector("S-REBOUND");
  const rebound = wrapDriver(new FakeDriver(), reboundCol).withChannel();
  ok(rebound instanceof FakeDriver, "§7 a rebound driver comes back of the same class");
  await rebound.replies();
  ok(reboundCol.texts().length === 2, "§7 …and it is wrapped too: a read through the rebound driver reaches the collector");
  const linCol = new PostedTextCollector("S-LIN", "linear");
  await wrapDriver(new FakeLinear(), linCol).replies();
  ok(JSON.stringify(linCol.texts().map((t) => t.text)) === JSON.stringify(["Filed it as a ticket."]), "§7 a wrapped Linear driver keeps only its app user's comments");

  const judgeLike = new (class Judge {
    grade(): string {
      return "x";
    }
  })();
  const config = { channel: "C0FAKE" };
  const fn = (): string => "f";
  const ctx = wrapScenarioDrivers({ slack: real, judge: judgeLike, config, fn, flag: true }, new PostedTextCollector("S-CTX"));
  ok(ctx.slack !== real && ctx.slack instanceof FakeDriver, "§7 the scenario's drivers are wrapped");
  ok(ctx.judge === judgeLike && ctx.config === config && ctx.fn === fn && ctx.flag === true, "§7 the judge, plain config, functions and flags pass through untouched");
}

ok(
  READER_JUDGE_MODEL === STACKS[SHIPPED_STACK].utility.id,
  `§8 the reader judge is the shipped stack's utility role (${STACKS[SHIPPED_STACK].utility.id}); got ${READER_JUDGE_MODEL}. Move READER_JUDGE_MODEL with the stack.`,
);
ok(STACKS[SHIPPED_STACK].utility.tier === "low", "§8 …and that role is the low tier, so the per-leg cost stays small");

{
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../packages/core/scripts/e2e/runner.ts"), "utf8");
  ok(runner.includes("scenario.run(wrapScenarioDrivers(ctx, readerCollector))"), "§9 the runner hands every leg its drivers WRAPPED by the leg's collector");
  ok(runner.includes("postedTexts.push(...readerCollector.texts())"), "§9 the runner keeps each leg's texts, red legs included");
  ok(/reviewPostedTexts\(postedTexts,/.test(runner) && runner.includes("renderReaderReport(review)"), "§9 the runner reviews the run's texts and prints the section");
  const reviewUses = runner.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").match(/\breview\b(?!Posted)/g) ?? [];
  ok(reviewUses.length === 2 && runner.includes("for (const line of renderReaderReport(review))"), `§9 the review is used only to render the section (uses: ${reviewUses.length})`);
  ok(/try \{\s*const calibration = [\s\S]{0,600}\} catch \(err\) \{\s*console\.log\(""\);\s*console\.log\(`## Reader check/.test(runner), "§9 the reader block is caught whole, so a failure prints one line and cannot change the exit path");
}

console.log(`reader-check-test: ${n} assertions passed`);
