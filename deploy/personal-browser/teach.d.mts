export const TEACH_MAX_MS: number;
export const TEACH_MAX_STEPS: number;

export type RecordedStep =
  | { readonly kind: "go"; readonly url: string }
  | { readonly kind: "arrive"; readonly url: string }
  | { readonly kind: "click"; readonly role: string; readonly name: string }
  | { readonly kind: "type"; readonly role: string; readonly name: string; readonly secret?: true }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "back" };

export interface Recording {
  readonly recording: false;
  readonly none?: true;
  readonly steps: RecordedStep[];
  readonly capped: boolean;
  readonly seconds: number;
}

export interface Recorder {
  recording(): boolean;
  start(maxMs: number | undefined, url: string): { recording: true; until: number };
  noteArrival(url: string): void;
  input(body: Record<string, unknown>, target: { role: string; name: string; secret?: boolean } | null): void;
  stop(url: string): Recording;
}

export interface TargetFacts {
  tag?: string;
  type?: string;
  roleAttr?: string;
  editable?: boolean;
  ariaLabel?: string;
  labelText?: string;
  innerText?: string;
  placeholder?: string;
  title?: string;
  alt?: string;
  name?: string;
  value?: string;
  autocomplete?: string;
  id?: string;
}

export const SECRET_NAME: RegExp;
export const SECRET_AUTOCOMPLETE: string[];
export function nameTarget(f: TargetFacts): { role: string; name: string; secret?: true };
export function pageAddress(raw: string): string | undefined;
export function createRecorder(now?: () => number): Recorder;
