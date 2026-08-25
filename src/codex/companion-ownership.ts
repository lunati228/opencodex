/** Durable, non-secret provenance for proxies launched by the Codex companion. */
export const CODEX_COMPANION_LIFECYCLE_OWNER = "codex-companion" as const;
export const OPENCODEX_LIFECYCLE_OWNER_ENV = "OPENCODEX_LIFECYCLE_OWNER" as const;

export type ProxyLifecycleOwner = typeof CODEX_COMPANION_LIFECYCLE_OWNER;

export function parseProxyLifecycleOwner(value: unknown): ProxyLifecycleOwner | undefined {
  return value === CODEX_COMPANION_LIFECYCLE_OWNER
    ? CODEX_COMPANION_LIFECYCLE_OWNER
    : undefined;
}

export function proxyLifecycleOwnerFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): ProxyLifecycleOwner | undefined {
  return parseProxyLifecycleOwner(env[OPENCODEX_LIFECYCLE_OWNER_ENV]);
}

export function withCompanionLifecycleOwner(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    [OPENCODEX_LIFECYCLE_OWNER_ENV]: CODEX_COMPANION_LIFECYCLE_OWNER,
  };
}
