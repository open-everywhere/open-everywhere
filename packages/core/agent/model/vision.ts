export interface ImageDescribeRequest {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly hint?: string;
}

export interface ImageDescribeUsage {
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
  readonly generationId?: string;
}

export interface ImageDescribeResult {
  readonly description: string;
  readonly ocrText?: string;
  readonly usage?: ImageDescribeUsage;
}

export interface ImageDescriber {
  describe(req: ImageDescribeRequest): Promise<ImageDescribeResult>;
}

let registered: ImageDescriber | null = null;

export function registerImageDescriber(describer: ImageDescriber): void {
  registered = describer;
}

export function getImageDescriber(): ImageDescriber | null {
  return registered;
}

export function _resetImageDescriberForTest(): void {
  registered = null;
}
