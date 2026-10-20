export function envFallbackValue(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  return value !== undefined && value !== "" ? value : undefined;
}

export function operatorSecretEnvFallbackPresent(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return envFallbackValue(name, env) !== undefined;
}
