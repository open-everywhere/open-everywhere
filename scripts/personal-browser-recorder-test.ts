import assert from "node:assert/strict";
import { createRecorder, nameTarget, pageAddress, TEACH_MAX_MS, TEACH_MAX_STEPS } from "../deploy/personal-browser/teach.mjs";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

ok(pageAddress("https://shop.example/orders/12?token=abc#frag") === "https://shop.example/orders/12", "🔴 an address keeps origin and path — the query (a token) and the fragment are dropped");
ok(pageAddress("about:blank") === undefined && pageAddress("javascript:alert(1)") === undefined && pageAddress("not a url") === undefined, "a non-http(s) address is no address");

{
  let t = 1_000_000;
  const rec = createRecorder(() => t);
  rec.input({ kind: "click", x: 1, y: 1 }, { role: "button", name: "Before" });
  ok(!rec.recording(), "nothing records before start");

  rec.start(undefined, "https://shop.example/home?session=s3cr3t");
  ok(rec.recording(), "start begins a recording");
  rec.input({ kind: "click", x: 10, y: 10 }, { role: "link", name: "  Your   orders " });
  rec.noteArrival("https://shop.example/orders?page=2");
  rec.noteArrival("https://shop.example/orders?page=3");
  rec.input({ kind: "text", text: "hunter2 and more" }, { role: "textbox", name: "Search orders" });
  rec.input({ kind: "text", text: "second burst" }, { role: "textbox", name: "Search orders" });
  rec.input({ kind: "text", text: "my-password" }, { role: "textbox", name: "Password", secret: true });
  rec.input({ kind: "key", key: "Enter" }, null);
  rec.input({ kind: "scroll", dy: 300 }, null);
  rec.input({ kind: "click", x: 5, y: 5 }, null);
  rec.input({ kind: "go", url: "https://shop.example/help?q=private" }, null);
  rec.input({ kind: "back" }, null);
  t += 42_000;
  const out = rec.stop("https://shop.example/home?session=again");
  const json = JSON.stringify(out);

  ok(!json.includes("hunter2") && !json.includes("second burst") && !json.includes("my-password"), "🔴 no typed text reaches the recording");
  ok(!json.includes("s3cr3t") && !json.includes("again") && !json.includes("page=2") && !json.includes("q=private"), "🔴 no query string reaches the recording");
  ok(!json.includes("Before"), "the click before start was not recorded");
  const kinds = out.steps.map((s) => s.kind).join(",");
  ok(kinds === "go,click,arrive,type,type,key,go,back,arrive", `the steps are the demonstration, in order (got ${kinds})`);
  ok(JSON.stringify(out.steps[0]) === JSON.stringify({ kind: "go", url: "https://shop.example/home" }), "the first step is where the demonstration started");
  ok(JSON.stringify(out.steps[1]) === JSON.stringify({ kind: "click", role: "link", name: "Your orders" }), "a click records the target's role and its label, whitespace collapsed");
  ok(out.steps.filter((s) => s.kind === "arrive" && s.url === "https://shop.example/orders").length === 1, "a navigation is ONE arrive step, however often the same page is noted");
  ok(out.steps.filter((s) => s.kind === "type" && s.name === "Search orders").length === 1, "many text events into one field are ONE step");
  ok(out.steps.some((s) => s.kind === "type" && s.name === "Password" && s.secret === true), "🔴 a secret field is marked secret");
  ok(!out.steps.some((s) => s.kind === "type" && s.name === "Search orders" && "secret" in s), "…and a plain field is not");
  ok(out.steps.some((s) => s.kind === "key" && s.key === "Enter"), "a key press records the key");
  ok(out.steps.filter((s) => s.kind === "click").length === 1, "a scroll and a click on nothing named add no step");
  ok(out.seconds === 42 && out.capped === false, "the recording reports its length and that it was not capped");
  ok(out.steps.every((s) => !("title" in s)), "🔴 no step keeps a page title (a results page's title repeats the search)");
  const second = rec.stop("https://shop.example/");
  ok(!rec.recording() && second.steps.length === 0 && second.none === true, "🔴 stop ends the recording, and a second stop says `none` — never an empty demonstration");
  ok(out.none === undefined, "…while a real stop carries no `none`");
  rec.input({ kind: "click", x: 1, y: 1 }, { role: "button", name: "After" });
  ok(!rec.recording(), "nothing records after stop");
}

{
  let t = 0;
  const rec = createRecorder(() => t);
  ok(TEACH_MAX_MS === 10 * 60_000, "the time cap is ten minutes");
  const started = rec.start(60 * 60_000, "about:blank");
  ok(started.until === TEACH_MAX_MS, "🔴 a longer request is clamped to ten minutes");
  rec.input({ kind: "click" }, { role: "button", name: "In time" });
  t = TEACH_MAX_MS + 1;
  rec.input({ kind: "click" }, { role: "button", name: "Too late" });
  const out = rec.stop("about:blank");
  ok(out.steps.length === 1 && out.steps[0]!.kind === "click" && out.capped === true, "an input after the time cap is not recorded, and the recording says it was capped");
  ok(out.seconds === 600, "the length stops at the cap");

  const many = createRecorder(() => 0);
  many.start(undefined, "about:blank");
  for (let i = 0; i < TEACH_MAX_STEPS + 20; i++) many.input({ kind: "key", key: "Tab" }, null);
  const full = many.stop("about:blank");
  ok(TEACH_MAX_STEPS === 200 && full.steps.length === TEACH_MAX_STEPS && full.capped === true, "the recording stops at 200 steps and says it was capped");
}

{
  const typed = "Dear Jane, my salary is 90k";
  const editor = nameTarget({ tag: "DIV", editable: true, innerText: typed });
  ok(!editor.name.includes("salary") && editor.role === "textbox", `🔴 a contenteditable editor with no role is a textbox named WITHOUT its contents (got ${JSON.stringify(editor)})`);
  ok(nameTarget({ tag: "DIV", editable: true, innerText: typed, ariaLabel: "Message body" }).name === "Message body", "…and is named from its aria-label");
  ok(!nameTarget({ tag: "DIV", roleAttr: "combobox", innerText: typed }).name.includes("salary"), "🔴 a combobox is never named from its text");
  ok(!nameTarget({ tag: "DIV", roleAttr: "textbox", innerText: typed, placeholder: "Write…" }).name.includes("salary"), "🔴 a role=textbox is never named from its text");
  ok(nameTarget({ tag: "TEXTAREA", innerText: typed, labelText: "Notes" }).name === "Notes", "🔴 a textarea is named from its label, never its contents");
  ok(nameTarget({ tag: "INPUT", type: "search", innerText: typed, placeholder: "Search" }).name === "Search", "a search input is named from its placeholder");
  ok(nameTarget({ tag: "INPUT", type: "date", name: "when" }).role === "textbox", "every non-button input is a textbox, as `look` names it");
  ok(nameTarget({ tag: "DIV", editable: true, ariaLabel: "One-time code" }).secret === true, "🔴 an editor is normalised to textbox BEFORE the secret test, so a code editor is secret");
  ok(nameTarget({ tag: "INPUT", type: "password", name: "pw" }).secret === true, "a password input is secret");
  ok(nameTarget({ tag: "INPUT", autocomplete: "cc-number", name: "x" }).secret === true, "a card-number autocomplete is secret");
  ok(JSON.stringify(nameTarget({ tag: "A", innerText: "  Your   orders " })) === JSON.stringify({ role: "link", name: "Your orders" }), "a link is named from its text (the positive control)");
  ok(nameTarget({ tag: "BUTTON", innerText: "Cancel order" }).name === "Cancel order" && nameTarget({ tag: "INPUT", type: "submit", value: "Pay" }).name === "Pay", "a button is named from its text or its value");
  ok(nameTarget({ tag: "A", innerText: "x".repeat(300) }).name.length === 80, "a label is capped at 80 characters");
}

console.log(`personal-browser-recorder: ${n} assertions passed`);
