export class CircuitBreaker {
  constructor({
    failureThreshold = 3,
    cooldownMs = 30_000,
    now = Date.now,
  } = {}) {
    if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1) {
      throw new Error("circuit failure threshold is invalid");
    }
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) {
      throw new Error("circuit cooldown is invalid");
    }
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.openedAtMs = null;
  }

  assertCanRequest() {
    if (this.openedAtMs === null) return;
    if (this.now() - this.openedAtMs >= this.cooldownMs) {
      this.openedAtMs = null;
      this.failures = 0;
      return;
    }
    throw new Error("review provider circuit is open");
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAtMs = null;
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAtMs = this.now();
    }
  }

  get isOpen() {
    return this.openedAtMs !== null;
  }
}

export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.max(0, Math.ceil(Number(text) * 1_000));
  }
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

function headerValue(headers, name) {
  if (headers && typeof headers.get === "function") {
    return headers.get(name);
  }
  if (headers && typeof headers === "object") {
    const key = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key ? String(headers[key]) : null;
  }
  return null;
}

async function disposeResponseBody(response, timeoutMs) {
  const body = response?.body;
  if (!body) return;
  let cancellation;
  try {
    if (typeof body.cancel === "function") {
      cancellation = Promise.resolve().then(() => body.cancel());
    } else if (typeof body.getReader === "function") {
      const reader = body.getReader();
      cancellation = Promise.resolve()
        .then(() => reader.cancel())
        .finally(() => reader.releaseLock());
    } else {
      return;
    }
  } catch {
    return;
  }
  let timer;
  await Promise.race([
    cancellation.catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function reviewWithRetry({
  send,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  maxAttempts = 3,
  baseDelayMs = 250,
  maxDelayMs = 5_000,
  responseDisposalTimeoutMs = 250,
  circuitBreaker = new CircuitBreaker({ now }),
  parseResponse = (response) => response.json(),
  validateResponse = (value) => value,
  signal,
}) {
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5 ||
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs < 0 ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < 1 ||
    !Number.isSafeInteger(responseDisposalTimeoutMs) ||
    responseDisposalTimeoutMs < 1 ||
    responseDisposalTimeoutMs > 5_000
  ) {
    throw new Error("retry policy is invalid");
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new Error("review provider request was aborted");
    }
    circuitBreaker.assertCanRequest();
    let response;
    try {
      response = await send();
    } catch {
      if (signal?.aborted) {
        throw new Error("review provider request was aborted");
      }
      circuitBreaker.recordFailure();
      if (circuitBreaker.isOpen) {
        throw new Error("review provider circuit opened after network failure");
      }
      if (attempt + 1 >= maxAttempts) {
        throw new Error("review provider network failure");
      }
      await abortableSleep(
        Math.min(maxDelayMs, baseDelayMs * 2 ** attempt),
        sleep,
        signal,
      );
      continue;
    }
    if (response?.status >= 200 && response.status < 300) {
      try {
        const value = validateResponse(await parseResponse(response));
        circuitBreaker.recordSuccess();
        return value;
      } catch {
        circuitBreaker.recordFailure();
        throw new Error("review provider returned an invalid response");
      }
    }
    await disposeResponseBody(response, responseDisposalTimeoutMs);
    const retryable =
      response?.status === 429 ||
      (response?.status >= 500 && response.status <= 599);
    circuitBreaker.recordFailure();
    if (!retryable) {
      throw new Error(`review provider rejected request with HTTP ${response?.status}`);
    }
    if (circuitBreaker.isOpen) {
      throw new Error("review provider circuit opened after repeated failure");
    }
    if (attempt + 1 >= maxAttempts) {
      throw new Error("review provider retry budget exhausted");
    }
    const retryAfter =
      response.status === 429
        ? parseRetryAfterMs(headerValue(response.headers, "retry-after"), now())
        : null;
    const exponential = baseDelayMs * 2 ** attempt;
    await abortableSleep(
      Math.min(maxDelayMs, retryAfter ?? exponential),
      sleep,
      signal,
    );
  }
  throw new Error("unreachable retry state");
}

async function abortableSleep(milliseconds, sleep, signal) {
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  if (signal.aborted) throw new Error("review provider request was aborted");
  let listener;
  try {
    await Promise.race([
      sleep(milliseconds),
      new Promise((_, reject) => {
        listener = () => reject(new Error("review provider request was aborted"));
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}
