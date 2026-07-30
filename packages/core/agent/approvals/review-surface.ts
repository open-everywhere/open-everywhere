export function inlineForReview(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}
