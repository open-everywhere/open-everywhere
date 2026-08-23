import type { ReleaseRecord } from "./schema.js";

export function structuralProblems(dirName: string, record: ReleaseRecord, knownScripts: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const ctx = `releases/${dirName}/migration.json`;

  if (record.sha !== dirName) {
    problems.push(`${ctx}: sha "${record.sha}" does not match its own directory name "${dirName}"`);
  }

  for (const name of record.verify) {
    if (!knownScripts.has(name)) problems.push(`${ctx}: verify names "${name}", which is not an npm script in this package.json`);
  }
  if (!knownScripts.has(record.rollback.command)) {
    problems.push(`${ctx}: rollback.command "${record.rollback.command}" is not an npm script in this package.json`);
  }

  const evePinChanged = record.changes.some((c) => c.unit === "evePin");
  if (evePinChanged) {
    const hasRotation = record.migrations.some((m) => /rotate/i.test(m.description) && /window/i.test(m.description));
    if (!hasRotation) {
      problems.push(`${ctx}: changes include an evePin entry but no migration describes rotating windows — every eve bump in this repo's history has needed one`);
    }
  }

  for (const m of record.migrations) {
    if (!m.backwardsCompatible && !record.rollback.notes) {
      problems.push(`${ctx}: migration "${m.id}" is not backwards-compatible but rollback.notes is absent — say what undoing it needs beyond "npm run ${record.rollback.command}"`);
    }
  }

  return problems;
}
