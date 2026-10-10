export function platformName(): "vercel" | "self-host" {
  return process.env.VERCEL ? "vercel" : "self-host";
}

export function onVercel(): boolean {
  return platformName() === "vercel";
}
