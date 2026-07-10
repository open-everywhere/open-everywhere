export interface ImageDescribeRequest {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly hint?: string;
}

export interface ImageDescribeResult {
  readonly description: string;
  readonly ocrText?: string;
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
