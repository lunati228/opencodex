export function assertLoopbackTarget(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("INVALID_LOOPBACK_URL");
  }
  if (url.protocol !== "http:") throw new Error("INVALID_LOOPBACK_PROTOCOL");
  if (
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.port
  ) {
    throw new Error("NON_LOOPBACK_TARGET");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("INVALID_LOOPBACK_PORT");
  }
  return { hostname: url.hostname, port, path: `${url.pathname}${url.search}` };
}

export function verifyHealthResponse(statusCode, body) {
  if (statusCode !== 200 || body?.status !== "ok") {
    throw new Error("SERVER_NOT_HEALTHY");
  }
  return { status: "ok" };
}

export function verifyModelIdentity(body, expectedModelId) {
  if (
    !body ||
    !Array.isArray(body.data) ||
    body.data.length !== 1 ||
    body.data[0]?.id !== expectedModelId
  ) {
    throw new Error("SERVER_MODEL_IDENTITY_MISMATCH");
  }
  return structuredClone(body.data[0]);
}

export function parseTokenizeResponse(statusCode, body) {
  if (
    statusCode !== 200 ||
    !Array.isArray(body?.tokens) ||
    body.tokens.some((token) => !Number.isInteger(token))
  ) {
    throw new Error("TOKENIZER_RESPONSE_INVALID");
  }
  return {
    count: body.tokens.length,
    provenance: "llama-server-b10099-/tokenize",
  };
}

export function verifyContextBudget(promptTokens, reservedTokens = 1024, contextSize = 8192) {
  if (
    !Number.isInteger(promptTokens) ||
    !Number.isInteger(reservedTokens) ||
    !Number.isInteger(contextSize) ||
    promptTokens < 0 ||
    reservedTokens < 1 ||
    contextSize < 1
  ) {
    throw new Error("INVALID_CONTEXT_BUDGET");
  }
  if (promptTokens + reservedTokens > contextSize) {
    throw new Error("CONTEXT_BUDGET_EXCEEDED");
  }
  return {
    fits: true,
    prompt_tokens: promptTokens,
    reserved_tokens: reservedTokens,
    context_size: contextSize,
    headroom_tokens: contextSize - promptTokens - reservedTokens,
    provenance: "llama-server-b10099-/tokenize",
  };
}

export function parseSlotEraseResponse(statusCode, body) {
  if (
    statusCode !== 200 ||
    body?.id_slot !== 0 ||
    !Number.isInteger(body?.n_erased) ||
    body.n_erased < 0
  ) {
    throw new Error("SLOT_ERASE_VERIFICATION_FAILED");
  }
  return { id_slot: 0, n_erased: body.n_erased };
}

export function buildChatRequest({
  model,
  messages,
  tools,
  firstRound,
  sampling,
  reasoningFormat,
}) {
  if (typeof model !== "string" || model.length === 0) throw new Error("INVALID_SERVER_MODEL_ID");
  if (!Array.isArray(messages) || !Array.isArray(tools)) throw new Error("INVALID_CHAT_INPUT");
  const sortedTools = structuredClone(tools).sort((a, b) =>
    a.function.name.localeCompare(b.function.name),
  );
  const value = {
    model,
    messages: structuredClone(messages),
    tools: sortedTools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: true,
    cache_prompt: !firstRound,
    seed: sampling.seed,
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    min_p: sampling.min_p,
    top_k: sampling.top_k,
    max_tokens: 1024,
    reasoning_format: reasoningFormat,
  };
  return { value, bytes: Buffer.from(JSON.stringify(value), "utf8") };
}
