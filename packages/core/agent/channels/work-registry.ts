const WORK_PLATFORM_ROLES: Record<string, string | undefined> = Object.create(null);

export function registerWorkPlatform(platform: string, workRole?: string): void {
  const existing = WORK_PLATFORM_ROLES[platform];
  WORK_PLATFORM_ROLES[platform] = existing ?? workRole;
}

export function registeredWorkPlatforms(): readonly string[] {
  return Object.keys(WORK_PLATFORM_ROLES).sort();
}

export function registeredWorkRole(platform: string): string | undefined {
  return WORK_PLATFORM_ROLES[platform];
}
