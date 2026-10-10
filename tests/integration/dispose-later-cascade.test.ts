import { __setTestValveForTest } from "@open-everywhere/core/agent/testing/test-valves.js";
import { expect, test } from "vitest";

import { ANY_SESSION, registerScript, scriptedStore } from "../../agent/model/scripted-model";
import { disposeLater } from "./harness";

__setTestValveForTest("scripted-model", true);

test("OPE-768 — THE BUG, reproduced directly: an inline-only dispose leaks when the code between registration and that dispose throws first", () => {
  const store = scriptedStore();
  expect(store.has(ANY_SESSION)).toBe(false);

  const handle = registerScript({ parent: [{ say: "ope768-bug-demo" }] });
  let threw = false;
  try {
    throw new Error("simulated assertion failure, before the inline dispose ever runs");
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);

  expect(store.has(ANY_SESSION)).toBe(true);
  expect(() => registerScript({ parent: [{ say: "ope768-collision" }] })).toThrow(/already registered/);

  handle.dispose();
  expect(store.has(ANY_SESSION)).toBe(false);
});

test("OPE-768 — THE FIX, part 1: disposeLater enrols the handle, but it is still live until THIS test's own afterEach runs", () => {
  const store = scriptedStore();
  expect(store.has(ANY_SESSION)).toBe(false);

  let threw = false;
  try {
    const handle = disposeLater(registerScript({ parent: [{ say: "ope768-fix-demo" }] }));
    void handle;
    throw new Error("simulated assertion failure, before any inline dispose exists at all");
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);

  expect(store.has(ANY_SESSION)).toBe(true);
});

test("OPE-768 — THE FIX, part 2: the NEXT test registers the same key with no friction — afterEach freed it", () => {
  const store = scriptedStore();
  expect(store.has(ANY_SESSION)).toBe(false);

  const handle = disposeLater(registerScript({ parent: [{ say: "ope768-fix-followup" }] }));
  expect(store.has(ANY_SESSION)).toBe(true);
  expect(handle.requests).toEqual([]);
});
