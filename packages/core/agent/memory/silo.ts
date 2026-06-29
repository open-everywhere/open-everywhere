export interface MemorySilo {
  readonly name: string;
  readonly provider: string;
  readonly container?: string;
  readonly path?: string;
  readonly readOnly?: boolean;
  readonly recursive?: boolean;
}

export function defineMemorySilo(silo: MemorySilo): MemorySilo {
  return silo;
}
