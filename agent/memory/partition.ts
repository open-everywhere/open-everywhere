export interface Partition {
  readonly platform: string;
  readonly workspace: string;
  readonly channel: string;
  readonly key: string;
  readonly relDir: string;
}

interface AuthLike {
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
}
type Resolvable = {
  readonly session?: {
    readonly auth?: {
      readonly current?: AuthLike | null;
      readonly initiator?: AuthLike | null;
    } | null;
  };
  readonly channel?: { readonly kind?: string; readonly continuationToken?: string };
};

const SAFE = /[^a-zA-Z0-9._-]+/g;

function seg(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().replace(SAFE, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 100) : fallback;
}

function workspaceFromAuth(ctx: Resolvable): string | undefined {
  const attrs =
    ctx.session?.auth?.current?.attributes ?? ctx.session?.auth?.initiator?.attributes;
  if (!attrs) return undefined;
  for (const k of ["team_id", "teamId", "workspace", "org_id", "orgId", "tenant"]) {
    const v = attrs[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

export function resolvePartition(ctx: Resolvable): Partition {
  const platform = seg(
    ctx.channel?.kind ?? process.env.OE_PLATFORM,
    "local",
  );
  const workspace = seg(
    workspaceFromAuth(ctx) ?? process.env.OE_WORKSPACE,
    "dev",
  );
  const channel = seg(process.env.OE_CHANNEL, "default");

  const relDir = `${platform}/${workspace}/${channel}`;
  return { platform, workspace, channel, key: relDir, relDir };
}
