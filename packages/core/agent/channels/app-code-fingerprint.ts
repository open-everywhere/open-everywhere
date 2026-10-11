let registered: string | undefined;

const APP_CODE_FINGERPRINT_SHAPE = /^[0-9a-f]{16}$/u;

export function registerAppCodeFingerprint(fingerprint: string): void {
  if (!APP_CODE_FINGERPRINT_SHAPE.test(fingerprint)) {
    throw new Error(
      `[open-everywhere:runtime-rotation] registerAppCodeFingerprint: ${JSON.stringify(fingerprint)} is not a 16-hex app fingerprint — re-run \`oe build\`.`,
    );
  }
  registered = fingerprint;
}

export function registeredAppCodeFingerprint(): string | undefined {
  return registered;
}

export function resetAppCodeFingerprintForTest(): void {
  registered = undefined;
}
