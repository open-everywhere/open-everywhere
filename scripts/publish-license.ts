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
