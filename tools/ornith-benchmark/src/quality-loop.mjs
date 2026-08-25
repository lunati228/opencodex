import { sha256Bytes } from "./hash.mjs";
import { buildChatRequest } from "./loopback.mjs";
import { validateRound } from "./schema.mjs";

function asSafeNs(value, name) {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`INVALID_ROUND_CLOCK: ${name}`);
  }
  return Number(value);
}

function assistantFromResponse(response) {
  const assistant = response.assistant;
  if (!assistant || typeof assistant !== "object") throw new Error("MISSING_ASSISTANT_RESPONSE");
  return {
    role: "assistant",
    reasoning_content:
      typeof assistant.reasoning_content === "string" ? assistant.reasoning_content : "",
    content: typeof assistant.content === "string" ? assistant.content : null,
    tool_calls: Array.isArray(assistant.tool_calls) ? structuredClone(assistant.tool_calls) : [],
  };
}

function parseToolArguments(toolCalls) {
  return toolCalls.map((call) => {
    if (
      typeof call?.id !== "string" ||
      call.id.length === 0 ||
      call.type !== "function" ||
      typeof call.function?.name !== "string" ||
      typeof call.function?.arguments !== "string"
    ) {
      throw new Error("MALFORMED_TOOL_CALL");
    }
    let input;
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      throw new Error("MALFORMED_TOOL_CALL");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("MALFORMED_TOOL_CALL");
    }
    return { call, input };
  });
}

async function countField(tokenizeText, value, remainingTimeMs) {
  const text = value ?? "";
  if (text.length === 0) {
    return {
      count: 0,
      provenance: null,
      sha256: sha256Bytes(Buffer.alloc(0)),
    };
  }
  const tokenized = await tokenizeText(text, {
    remainingTimeMs: remainingTimeMs(),
  });
  remainingTimeMs();
  if (!Number.isInteger(tokenized.count) || tokenized.count < 0) {
    throw new Error("POSTPROCESS_TOKEN_COUNT_INVALID");
  }
  return {
    count: tokenized.count,
    provenance: tokenized.provenance,
    sha256: sha256Bytes(Buffer.from(text, "utf8")),
  };
}

function aggregateTokenEvidence(items, text) {
  const provenances = items
    .map(({ provenance }) => provenance)
    .filter(Boolean);
  return {
    count: items.reduce((sum, { count }) => sum + count, 0),
    provenance:
      provenances.length > 0 && new Set(provenances).size === 1
        ? provenances[0]
        : null,
    sha256: sha256Bytes(Buffer.from(text, "utf8")),
  };
}

export async function runToolCase({
  phase,
  caseId,
  initialMessages,
  tools,
  sampling,
  reasoningFormat,
  model,
  context,
  verifyRenderedPrompt,
  streamRound,
  executeToolFn,
  tokenizeText,
  nowNs = () => process.hrtime.bigint(),
  maximumRounds = 32,
  maximumCaseMs = 6 * 60_000,
  absoluteDeadlineNs,
}) {
  const caseStartedNs = nowNs();
  const localDeadlineNs =
    caseStartedNs + BigInt(maximumCaseMs) * 1_000_000n;
  if (
    absoluteDeadlineNs !== undefined &&
    (typeof absoluteDeadlineNs !== "bigint" ||
      absoluteDeadlineNs < caseStartedNs)
  ) {
    throw new Error("INVALID_ABSOLUTE_CASE_DEADLINE");
  }
  const deadlineNs =
    absoluteDeadlineNs === undefined ||
    localDeadlineNs < absoluteDeadlineNs
      ? localDeadlineNs
      : absoluteDeadlineNs;
  const remainingTimeMs = () => {
    const remainingNs = deadlineNs - nowNs();
    if (remainingNs <= 0n) throw new Error("CASE_TIME_CAP_EXCEEDED");
    return Number(remainingNs / 1_000_000n);
  };
  const messages = structuredClone(initialMessages);
  const rounds = [];
  const reasoningParts = [];
  const answerParts = [];
  const serializedToolCalls = [];
  const roundReasoningEvidence = [];
  const roundAnswerEvidence = [];
  const roundToolCallEvidence = [];
  let finalAnswer = null;
  let toolRoundCount = 0;

  for (let roundIndex = 0; roundIndex < maximumRounds; roundIndex += 1) {
    remainingTimeMs();
    const budget = await verifyRenderedPrompt({
      messages,
      tools,
      deadlineNs,
      remainingTimeMs: remainingTimeMs(),
    });
    remainingTimeMs();
    if (!budget?.fits) throw new Error("CONTEXT_BUDGET_EXCEEDED");
    const { value: request } = buildChatRequest({
      model,
      messages,
      tools,
      firstRound: roundIndex === 0,
      sampling,
      reasoningFormat,
    });

    let response;
    let assistant;
    let parsedCalls;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await streamRound({
        request,
        roundIndex,
        attempt,
        deadlineNs,
        remainingTimeMs: remainingTimeMs(),
      });
      remainingTimeMs();
      assistant = assistantFromResponse(response);
      try {
        parsedCalls = parseToolArguments(assistant.tool_calls);
        break;
      } catch (error) {
        if (attempt === 1) throw new Error("MALFORMED_TOOL_CALL_AFTER_RETRY");
      }
    }

    const timings = response.assistant.timings ?? response.timings;
    const usage = response.assistant.usage ?? response.usage;
    if (!timings || !usage) throw new Error("ROUND_METRICS_MISSING");
    const requestStart = asSafeNs(response.request_start_ns, "request_start_ns");
    const requestSent = asSafeNs(response.request_sent_ns, "request_sent_ns");
    const firstEvent = asSafeNs(response.first_sse_event_ns, "first_sse_event_ns");
    const firstOutput = asSafeNs(response.first_output_ns, "first_output_ns");
    const responseEnd = asSafeNs(response.response_end_ns, "response_end_ns");
    const round = {
      phase,
      case_id: caseId,
      round_index: roundIndex,
      started_at_utc: new Date().toISOString(),
      request_start_ns: requestStart,
      request_sent_ns: requestSent,
      first_sse_event_ns: firstEvent,
      first_output_ns: firstOutput,
      response_end_ns: responseEnd,
      cache_n: Number.isInteger(timings.cache_n) ? timings.cache_n : null,
      prompt_n: Number.isInteger(timings.prompt_n) ? timings.prompt_n : null,
      prompt_ms: Number.isFinite(timings.prompt_ms) ? timings.prompt_ms : null,
      predicted_n: Number.isInteger(timings.predicted_n) ? timings.predicted_n : null,
      predicted_ms: Number.isFinite(timings.predicted_ms) ? timings.predicted_ms : null,
      ttft_ms: (firstOutput - requestStart) / 1e6,
      post_upload_ttft_ms: (firstOutput - requestSent) / 1e6,
      total_wall_ms: (responseEnd - requestStart) / 1e6,
      tool_calls: structuredClone(assistant.tool_calls),
      tool_latency_ms_sum: 0,
      tool_round_wall_ms: 0,
      normal_speed_sample:
        Number.isInteger(timings.predicted_n) && timings.predicted_n >= 64,
      outcome: "pass",
      abort_reason: null,
      context_budget: budget,
    };
    round.prefill_tok_s =
      round.prompt_n !== null && round.prompt_ms > 0
        ? round.prompt_n / (round.prompt_ms / 1000)
        : null;
    round.decode_tok_s =
      round.predicted_n !== null && round.predicted_ms > 0
        ? round.predicted_n / (round.predicted_ms / 1000)
        : null;
    const reasoningText = assistant.reasoning_content;
    const answerText = assistant.content ?? "";
    const toolCallText = assistant.tool_calls
      .map((call) => JSON.stringify(call))
      .join("");
    const [
      reasoningTokens,
      answerTokens,
      toolCallTokens,
    ] = await Promise.all([
      countField(tokenizeText, reasoningText, remainingTimeMs),
      countField(tokenizeText, answerText, remainingTimeMs),
      countField(tokenizeText, toolCallText, remainingTimeMs),
    ]);
    round.reasoning_tokens = reasoningTokens.count;
    round.answer_tokens = answerTokens.count;
    roundReasoningEvidence.push(reasoningTokens);
    roundAnswerEvidence.push(answerTokens);
    roundToolCallEvidence.push(toolCallTokens);
    reasoningParts.push(reasoningText);
    answerParts.push(answerText);
    serializedToolCalls.push(toolCallText);

    if (parsedCalls.length === 0) {
      finalAnswer = assistant.content ?? "";
      rounds.push(validateRound(round));
      break;
    }

    toolRoundCount += 1;
    messages.push(assistant);
    const toolRoundStarted = nowNs();
    for (const { call, input } of parsedCalls) {
      const dispatchNs = nowNs();
      const result = await executeToolFn(
        context,
        call.function.name,
        input,
        {
          deadlineNs,
          remainingTimeMs: remainingTimeMs(),
        },
      );
      remainingTimeMs();
      const resultNs = nowNs();
      const measuredMs = Number(resultNs - dispatchNs) / 1e6;
      round.tool_latency_ms_sum += measuredMs;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result),
      });
    }
    round.tool_round_wall_ms = Number(nowNs() - toolRoundStarted) / 1e6;
    rounds.push(validateRound(round));
  }

  if (finalAnswer === null) throw new Error("MODEL_ROUND_LIMIT_EXCEEDED");
  const reasoningText = reasoningParts.join("");
  const answerText = answerParts.join("");
  const toolText = serializedToolCalls.join("");
  const reasoningTokens = aggregateTokenEvidence(
    roundReasoningEvidence,
    reasoningText,
  );
  const answerTokens = aggregateTokenEvidence(
    roundAnswerEvidence,
    answerText,
  );
  const toolCallTokens = aggregateTokenEvidence(
    roundToolCallEvidence,
    toolText,
  );
  const provenances = [reasoningTokens, answerTokens, toolCallTokens]
    .map((item) => item.provenance)
    .filter(Boolean);
  return {
    case_id: caseId,
    rounds,
    messages,
    final_answer: finalAnswer,
    reasoning_content: reasoningText,
    tool_round_count: toolRoundCount,
    token_counts: {
      reasoning: reasoningTokens,
      answer: answerTokens,
      tool_calls: toolCallTokens,
      provenance: provenances.length > 0 && new Set(provenances).size === 1
        ? provenances[0]
        : null,
    },
  };
}
