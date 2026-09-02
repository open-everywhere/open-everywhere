import { expect, test } from "vitest";

import { setEnvForRunningAgent } from "../harness";

const NAME = "OE_IT_OPE1320_PROBE";

function justBashShapedEnv(realEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return new Proxy(realEnv, {
    get: (o, i, c) => Reflect.get(o, i, c),
    set: (o, i, c, l) => Reflect.set(o, i, c, l),
    defineProperty: (o, i, c) => Reflect.defineProperty(o, i, c),
    getOwnPropertyDescriptor: (o, i) => Reflect.getOwnPropertyDescriptor(o, i),
    ownKeys: (o) => Reflect.ownKeys(o),
    has: (o, i) => Reflect.has(o, i),
    deleteProperty: (o, i) => Reflect.deleteProperty(o, i),
  });
}

function withReplacedEnv(replacement: NodeJS.ProcessEnv): () => void {
  const pristine = Object.getOwnPropertyDescriptor(process, "env");
  if (pristine === undefined) throw new Error("env-seam: process has no own `env` descriptor — the whole seam rests on one");
  Object.defineProperty(process, "env", { ...pristine, value: replacement });
  return () => Object.defineProperty(process, "env", pristine);
}

test("a bare rewrite of an existing variable throws through a just-bash-shaped process.env", () => {
  const realEnv = process.env;
  realEnv[NAME] = "first";
  const replacement = justBashShapedEnv(realEnv);
  const restore = withReplacedEnv(replacement);
  try {
    expect(() => {
      process.env[NAME] = "bare-rewrite";
    }).toThrow(/only accepts a configurable, writable, and enumerable data descriptor/u);
    expect(() => setEnvForRunningAgent(NAME, "through-the-seam")).not.toThrow();
    expect(realEnv[NAME]).toBe("through-the-seam");
    expect(process.env).toBe(replacement);
  } finally {
    restore();
    delete process.env[NAME];
  }
});

test("a bare FIRST write to an absent variable does NOT throw — the trigger is the rewrite", () => {
  const realEnv = process.env;
  delete realEnv[NAME];
  const restore = withReplacedEnv(justBashShapedEnv(realEnv));
  try {
    expect(() => {
      process.env[NAME] = "first-write";
    }).not.toThrow();
    expect(realEnv[NAME]).toBe("first-write");
  } finally {
    restore();
    delete process.env[NAME];
  }
});

test("the replacement is a VIEW over the real env — a write through the seam is readable through it", () => {
  const realEnv = process.env;
  realEnv[NAME] = "first";
  const replacement = justBashShapedEnv(realEnv);
  const restore = withReplacedEnv(replacement);
  try {
    setEnvForRunningAgent(NAME, "through-the-seam");
    expect(replacement[NAME]).toBe("through-the-seam");
  } finally {
    restore();
    delete process.env[NAME];
  }
});

test("with an ordinary process.env the seam is a plain assignment", () => {
  try {
    setEnvForRunningAgent(NAME, "ordinary");
    expect(process.env[NAME]).toBe("ordinary");
  } finally {
    delete process.env[NAME];
  }
});
