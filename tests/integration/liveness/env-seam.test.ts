import { expect, test } from "vitest";

import { setEnvForRunningAgent } from "../harness";

const NAME = "OE_IT_OPE1320_PROBE";

test("setEnvForRunningAgent writes through a process.env whose set path throws, and leaves it as it found it", () => {
  const pristine = Object.getOwnPropertyDescriptor(process, "env");
  expect(pristine).toBeDefined();
  const realEnv = process.env;

  const hostile = new Proxy(realEnv, {
    set(): never {
      throw new TypeError("'process.env' only accepts a configurable, writable, and enumerable data descriptor");
    },
  });
  Object.defineProperty(process, "env", { ...pristine!, value: hostile });

  try {
    expect(() => {
      process.env[NAME] = "bare-assignment";
    }).toThrow(/only accepts a configurable, writable, and enumerable data descriptor/u);

    expect(() => setEnvForRunningAgent(NAME, "through-the-seam")).not.toThrow();
    expect(realEnv[NAME]).toBe("through-the-seam");
    expect(process.env).toBe(hostile);
  } finally {
    Object.defineProperty(process, "env", pristine!);
    delete process.env[NAME];
  }
});

test("NEGATIVE CONTROL: with an ordinary process.env the seam is a plain assignment", () => {
  try {
    setEnvForRunningAgent(NAME, "ordinary");
    expect(process.env[NAME]).toBe("ordinary");
  } finally {
    delete process.env[NAME];
  }
});
