export const README_FILE = "README.md";

export const README_MIN_CHARS = 200;

export interface PackageReadmeInput {
  readonly readme: string | undefined;
}

export function checkPackageReadme(input: PackageReadmeInput): readonly string[] {
  if (input.readme === undefined) {
    return [`no ${README_FILE} at the package root — npm renders the package page from it, so the page would read "This package does not have a README"`];
  }
  const body = input.readme.replace(/\s+/gu, "");
  if (body.length < README_MIN_CHARS) {
    return [`${README_FILE} holds only ${body.length} non-whitespace characters (floor ${README_MIN_CHARS}) — an empty README renders an empty npm page, which a present-file check cannot tell from a real one`];
  }
  return [];
}

export function checkTarballReadme(listing: readonly string[]): readonly string[] {
  return listing.includes(README_FILE) ? [] : [`${README_FILE} is not in the tarball — npm would render no package page`];
}

const EVE_SPEC_PATTERN = /(?:(?<=(?:^|\s)[_*]{1,3})|(?<![\w/@*_-]))eve@([^\s`'"*_~(){}\[\],;]+)/gu;

const SPEC_TRAILERS = /[.:!?>]+$/u;

export interface ReadmeEvePinInput {
  readonly readme: string | undefined;
  readonly pin: string;
}

export function checkReadmeEvePin(input: ReadmeEvePinInput): readonly string[] {
  if (input.readme === undefined) return [];
  const problems: string[] = [];
  const reported = new Set<string>();
  for (const match of input.readme.matchAll(EVE_SPEC_PATTERN)) {
    const spec = match[1]!.replace(SPEC_TRAILERS, "");
    if (spec === input.pin || reported.has(spec)) continue;
    reported.add(spec);
    problems.push(
      `${README_FILE} names \`eve@${spec}\`, but @open-everywhere/core pins eve at ${input.pin} — ` +
        `the README is the npm page, so a consumer copies that line, installs a version ` +
        `\`oe-eve-patch\` refuses, and core then refuses to boot on the unpatched tree. Read the ` +
        `version from core's \`peerDependencies.eve\`.`,
    );
  }
  return problems;
}
