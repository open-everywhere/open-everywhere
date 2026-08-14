const MARKER = "OE_FETCH_GUARD_TRIPPED";

globalThis.fetch = (input) => {
  const target = typeof input === "string" ? input : String(input);
  process.stderr.write(`${MARKER}: ${target}\n`);
  throw new Error(`${MARKER}: a real fetch() was attempted (${target})`);
};
