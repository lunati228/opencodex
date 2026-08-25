import { describe, expect, test } from "bun:test";
import {
  CODEX_COMPANION_LIFECYCLE_OWNER,
  OPENCODEX_LIFECYCLE_OWNER_ENV,
  parseProxyLifecycleOwner,
  proxyLifecycleOwnerFromEnvironment,
  withCompanionLifecycleOwner,
} from "../src/codex/companion-ownership";

describe("Codex companion lifecycle provenance", () => {
  test("accepts only the exact bounded owner marker", () => {
    expect(parseProxyLifecycleOwner(CODEX_COMPANION_LIFECYCLE_OWNER))
      .toBe(CODEX_COMPANION_LIFECYCLE_OWNER);
    expect(parseProxyLifecycleOwner("foreign")).toBeUndefined();
    expect(parseProxyLifecycleOwner(true)).toBeUndefined();
    expect(proxyLifecycleOwnerFromEnvironment({
      [OPENCODEX_LIFECYCLE_OWNER_ENV]: CODEX_COMPANION_LIFECYCLE_OWNER,
    })).toBe(CODEX_COMPANION_LIFECYCLE_OWNER);
  });

  test("adds provenance without mutating the caller's environment", () => {
    const base: NodeJS.ProcessEnv = { PATH: "fixture" };
    const marked = withCompanionLifecycleOwner(base);

    expect(marked).not.toBe(base);
    expect(base[OPENCODEX_LIFECYCLE_OWNER_ENV]).toBeUndefined();
    expect(marked.PATH).toBe("fixture");
    expect(marked[OPENCODEX_LIFECYCLE_OWNER_ENV])
      .toBe(CODEX_COMPANION_LIFECYCLE_OWNER);
  });
});
