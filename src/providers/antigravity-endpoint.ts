export const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_QUOTA_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`;

/** Accept only the configured first-party origin, with an optional single trailing slash. */
export function isCanonicalAntigravityBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && url.origin.toLowerCase() === ANTIGRAVITY_BASE_URL
      && url.pathname === "/";
  } catch {
    return false;
  }
}

/** Build inference URLs without ever interpolating user-editable provider configuration. */
export function antigravityInferenceUrl(stream: boolean): string {
  return stream
    ? `${ANTIGRAVITY_BASE_URL}/v1internal:streamGenerateContent?alt=sse`
    : `${ANTIGRAVITY_BASE_URL}/v1internal:generateContent`;
}
