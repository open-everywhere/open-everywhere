export const taintContextLine = (text: string): string => /context:[^\n]*/i.exec(text)?.[0] ?? "";

export const isLiveTaintLine = (line: string): boolean => line.length > 0 && !/supplied by the caller/i.test(line);
