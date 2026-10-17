export async function exitAfterFlush(code: number): Promise<never> {
  process.stdout.once("error", () => process.exit(code));
  process.stderr.once("error", () => process.exit(code));
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  await new Promise<void>((done) => process.stderr.write("", () => done()));
  process.exit(code);
}
