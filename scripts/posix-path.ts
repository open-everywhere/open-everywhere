import path from "node:path";

export interface PathApi {
  readonly sep: string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
}

export function toPosixPath(p: string, pathSep: string = path.sep): string {
  return pathSep === "/" ? p : p.split(pathSep).join("/");
}

export function posixRelative(from: string, to: string, pathApi: PathApi = path): string {
  return toPosixPath(pathApi.relative(from, to), pathApi.sep);
}

export function posixJoin(...parts: string[]): string {
  return toPosixPath(path.join(...parts));
}
