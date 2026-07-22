export function platformName(): string {
  const override = process.env.OE_PLATFORM?.trim().toLowerCase();
  if (override) return override;
  if (process.env.VERCEL) return "vercel";
  return "self-host";
}

export function onVercel(): boolean {
  return platformName() === "vercel";
}
