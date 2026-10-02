import { codemodIdsIn, type ReleaseNote } from "./upgrade-notes.js";

export interface Codemod {
  readonly id: string;
  readonly describe: string;
  run(appRoot: string): readonly string[];
}

export const CODEMODS: readonly Codemod[] = [];

export function codemodById(id: string): Codemod | undefined {
  return CODEMODS.find((c) => c.id === id);
}

export function unknownCodemods(releases: readonly ReleaseNote[]): readonly string[] {
  return codemodIdsIn(releases).filter((id) => codemodById(id) === undefined);
}
