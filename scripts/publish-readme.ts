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
