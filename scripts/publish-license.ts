export const LICENSE_FILE = "LICENSE";

export function noticeClaimsLicenseFile(notice: string): boolean {
  return /\bsee\s+(?:the\s+)?LICENSE\b/u.test(notice);
}

export interface PackageLicenseInput {
  readonly notice?: string;
  readonly license?: string;
  readonly rootLicense: string;
  readonly files: readonly string[];
}

export function checkPackageLicense(input: PackageLicenseInput): readonly string[] {
  const problems: string[] = [];
  const claimed = input.notice !== undefined && noticeClaimsLicenseFile(input.notice);

  if (input.license === undefined) {
    problems.push(
      `no ${LICENSE_FILE} at the package root${claimed ? ", and its NOTICE tells the reader to see one" : ""} — npm includes a licence file from nowhere else, so the Apache-2.0 text reaches no consumer. Copy the repository ${LICENSE_FILE} into the package root.`,
    );
  } else if (input.license !== input.rootLicense) {
    problems.push(
      `${LICENSE_FILE} differs from the repository ${LICENSE_FILE} — every package ships the same grant, byte for byte. Re-copy it.`,
    );
  }
  if (!input.files.includes(LICENSE_FILE)) {
    problems.push(
      `the files allowlist does not name ${LICENSE_FILE} — npm ships one anyway, so the allowlist would describe a tarball that is not the one published. Add it.`,
    );
  }
  return problems;
}

export function checkTarballLicense(listing: readonly string[]): readonly string[] {
  return listing.includes(LICENSE_FILE) ? [] : [`${LICENSE_FILE} is not in the tarball`];
}

export const NOTICE_FILE = "NOTICE";

export const NOTICE_MODIFICATIONS_HEADING = "Modifications to eve";

const EVE_TARGET_PREFIX = "b/node_modules/eve/";

export function patchTargets(patch: string): readonly string[] {
  return [...patch.matchAll(/^\+\+\+ (\S+)/gmu)].map((m) => {
    const target = m[1] ?? "";
    return target.startsWith(EVE_TARGET_PREFIX) ? target.slice(EVE_TARGET_PREFIX.length) : target;
  });
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

export interface NoticeModifications {
  readonly countWord?: string;
  readonly files: readonly string[];
}

export function noticeModifications(notice: string): NoticeModifications | undefined {
  const lines = notice.split(/\r?\n/u);
  const start = lines.indexOf(NOTICE_MODIFICATIONS_HEADING);
  if (start === -1) return undefined;
  const end = lines.indexOf("---", start + 1);
  const section = lines.slice(start + 1, end === -1 ? undefined : end);
  const count = /\bThe patch modifies (\S+) files? of eve\b/u.exec(section.join(" "));
  return {
    ...(count?.[1] !== undefined ? { countWord: count[1] } : {}),
    files: section.flatMap((line) => {
      const m = /^ {2}(\S+)$/u.exec(line);
      return m?.[1] !== undefined ? [m[1]] : [];
    }),
  };
}

export function checkNoticeModifications(notice: string, patch: string): readonly string[] {
  const targets = patchTargets(patch);
  const claim = noticeModifications(notice);
  if (claim === undefined) {
    return [`the NOTICE has no "${NOTICE_MODIFICATIONS_HEADING}" section, and the shipped patch modifies ${targets.length} eve file(s) — Apache-2.0 §4(b) asks for a notice of the change.`];
  }
  const problems: string[] = [];
  const missing = targets.filter((t) => !claim.files.includes(t));
  const extra = claim.files.filter((f) => !targets.includes(f));
  if (missing.length > 0) problems.push(`the NOTICE does not name ${missing.join(", ")}, which the patch modifies. Add the path to "${NOTICE_MODIFICATIONS_HEADING}".`);
  if (extra.length > 0) problems.push(`the NOTICE names ${extra.join(", ")}, which the patch does not modify. Remove the path.`);
  if (missing.length === 0 && extra.length === 0 && claim.files.join("\n") !== targets.join("\n")) {
    problems.push(`the NOTICE lists the patched files in a different order from the patch's +++ lines. Use the patch order.`);
  }
  const want = COUNT_WORDS[targets.length];
  if (claim.countWord !== want) {
    problems.push(`the NOTICE says the patch modifies ${claim.countWord ?? "(no count sentence)"} file(s), and the patch modifies ${want ?? targets.length}. Correct "The patch modifies <n> files of eve".`);
  }
  return problems;
}

export function checkPackageNotice(notice: string | undefined, rootNotice: string): readonly string[] {
  if (notice === undefined) return [`no ${NOTICE_FILE} at the package root — copy the repository ${NOTICE_FILE} into it.`];
  return notice === rootNotice ? [] : [`${NOTICE_FILE} differs from the repository ${NOTICE_FILE} — every package ships the same notice, byte for byte. Re-copy it.`];
}
