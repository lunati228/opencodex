import http from "node:http";

import {
  assertLoopbackTarget,
  parseSlotEraseResponse,
  parseTokenizeResponse,
  verifyContextBudget,
  verifyHealthResponse,
  verifyModelIdentity,
} from "./loopback.mjs";
import { SseAccumulator } from "./sse.mjs";
import { sha256Bytes } from "./hash.mjs";
import path from "node:path";

function boundedJsonBody(chunks, bytes, maxBytes) {
  if (bytes > maxBytes) throw new Error("HTTP_RESPONSE_CAP_EXCEEDED");
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_HTTP_JSON");
  }
  return body;
}

export async function requestLoopbackJson({
  url,
  method = "GET",
  body,
  timeoutMs = 30_000,
  maxBytes = 4 * 1024 * 1024,
  signal,
}) {
  const target = assertLoopbackTarget(url);
  const requestBytes = body === undefined
    ? null
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const request = http.request({
      ...target,
      method,
      headers: {
        Accept: "application/json",
        ...(requestBytes
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(requestBytes.length),
            }
          : {}),
      },
      agent: false,
    });
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => {
      request.destroy(new Error("HTTP_REQUEST_ABORTED"));
    };
    const timer = setTimeout(() => {
      request.destroy(new Error("HTTP_REQUEST_TIMEOUT"));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    request.once("error", (error) => settle(reject, error));
    request.once("response", (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy(new Error("HTTP_RESPONSE_CAP_EXCEEDED"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("error", (error) => settle(reject, error));
      response.once("end", () => {
        try {
          settle(resolve, {
            status_code: response.statusCode,
            headers: response.headers,
            body: boundedJsonBody(chunks, bytes, maxBytes),
            raw: Buffer.concat(chunks),
          });
        } catch (error) {
          settle(reject, error);
        }
      });
    });
    request.end(requestBytes);
  });
}

export function assembleAssistantFromSse(parsed) {
  let reasoningContent = "";
  let content = "";
  const calls = new Map();
  for (const event of parsed.events) {
    for (const choice of event.value?.choices ?? []) {
      const delta = choice?.delta;
      if (typeof delta?.reasoning_content === "string") {
        reasoningContent += delta.reasoning_content;
      }
      if (typeof delta?.content === "string") content += delta.content;
      for (const fragment of delta?.tool_calls ?? []) {
        if (!Number.isInteger(fragment.index) || fragment.index < 0) {
          throw new Error("INVALID_TOOL_CALL_INDEX");
        }
        const current = calls.get(fragment.index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (typeof fragment.id === "string") current.id += fragment.id;
        if (typeof fragment.type === "string") current.type = fragment.type;
        if (typeof fragment.function?.name === "string") {
          current.function.name += fragment.function.name;
        }
        if (typeof fragment.function?.arguments === "string") {
          current.function.arguments += fragment.function.arguments;
        }
        calls.set(fragment.index, current);
      }
    }
  }
  const orderedIndexes = [...calls.keys()].sort((a, b) => a - b);
  if (orderedIndexes.some((value, index) => value !== index)) {
    throw new Error("NONCONTIGUOUS_TOOL_CALL_INDEX");
  }
  return {
    reasoning_content: reasoningContent,
    content: content.length > 0 ? content : null,
    tool_calls: orderedIndexes.map((index) => calls.get(index)),
    timings: structuredClone(parsed.terminal.timings),
    usage: structuredClone(parsed.terminal.usage),
  };
}

export async function streamLoopbackChat({
  url,
  requestBytes,
  idleTimeoutMs = 180_000,
  overallTimeoutMs = 6 * 60_000,
  maxBytes = 32 * 1024 * 1024,
  maxEvents = 100_000,
  signal,
}) {
  const target = assertLoopbackTarget(url);
  const body = Buffer.from(requestBytes);
  const parser = new SseAccumulator({ maxBytes, maxEvents });
  const requestStartNs = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const request = http.request({
      ...target,
      method: "POST",
      headers: {
        Host: `127.0.0.1:${target.port}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Connection: "keep-alive",
        "Content-Length": String(body.length),
      },
    });
    let requestSentNs = null;
    let settled = false;
    let idleTimer;
    const overallTimer = setTimeout(() => {
      request.destroy(new Error("CASE_TIME_CAP_EXCEEDED"));
    }, overallTimeoutMs);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        request.destroy(new Error("SSE_IDLE_TIMEOUT"));
      }, idleTimeoutMs);
    };
    const abort = () => request.destroy(new Error("HTTP_REQUEST_ABORTED"));
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.once("finish", () => {
      requestSentNs = process.hrtime.bigint();
      resetIdle();
    });
    request.once("error", (error) => settle(reject, error));
    request.once("response", (response) => {
      if (
        response.statusCode !== 200 ||
        !String(response.headers["content-type"] ?? "").toLowerCase().includes("text/event-stream")
      ) {
        response.resume();
        settle(reject, new Error(`INVALID_SSE_HTTP_RESPONSE: ${response.statusCode}`));
        return;
      }
      response.on("data", (chunk) => {
        resetIdle();
        try {
          parser.push(chunk);
        } catch (error) {
          response.destroy(error);
        }
      });
      response.once("error", (error) => settle(reject, error));
      response.once("end", () => {
        try {
          const responseEndNs = process.hrtime.bigint();
          const parsed = parser.finish();
          if (parsed.first_output_ns === null) throw new Error("SSE_FIRST_OUTPUT_MISSING");
          settle(resolve, {
            assistant: assembleAssistantFromSse(parsed),
            request_start_ns: requestStartNs,
            request_sent_ns: requestSentNs,
            first_sse_event_ns: parsed.first_sse_event_ns,
            first_output_ns: parsed.first_output_ns,
            response_end_ns: responseEndNs,
            raw: parsed.raw,
            events: parsed.events,
          });
        } catch (error) {
          settle(reject, error);
        }
      });
    });
    request.end(body);
  });
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

export function verifyRuntimeBuildInfo(
  buildInfo,
  expectedBuildMarker,
  expectedCommit,
) {
  if (
    typeof buildInfo !== "string" ||
    typeof expectedBuildMarker !== "string" ||
    expectedBuildMarker.length === 0 ||
    typeof expectedCommit !== "string" ||
    expectedCommit.length < 7 ||
    !buildInfo.includes(expectedBuildMarker) ||
    !buildInfo.includes(expectedCommit.slice(0, 7))
  ) {
    throw new Error("SERVER_RUNTIME_IDENTITY_MISMATCH");
  }
  return buildInfo;
}

export async function checkLiveServer({
  baseUrl,
  expectedModelId,
  expectedModelPath,
  expectedCommit,
  expectedBuildMarker = "b10099",
}) {
  const health = await requestLoopbackJson({ url: `${baseUrl}/health` });
  verifyHealthResponse(health.status_code, health.body);
  const models = await requestLoopbackJson({ url: `${baseUrl}/v1/models` });
  const identity = verifyModelIdentity(models.body, expectedModelId);
  const props = await requestLoopbackJson({ url: `${baseUrl}/props` });
  if (
    props.status_code !== 200 ||
    typeof props.body?.model_path !== "string" ||
    !samePath(props.body.model_path, expectedModelPath) ||
    props.body.total_slots !== 1
  ) {
    throw new Error("SERVER_RUNTIME_IDENTITY_MISMATCH");
  }
  verifyRuntimeBuildInfo(
    props.body.build_info,
    expectedBuildMarker,
    expectedCommit,
  );
  return {
    health: health.body,
    model: identity,
    runtime: {
      model_path: props.body.model_path,
      total_slots: props.body.total_slots,
      build_info: props.body.build_info,
      chat_template_sha256:
        typeof props.body.chat_template === "string"
          ? sha256Bytes(Buffer.from(props.body.chat_template, "utf8"))
          : null,
    },
  };
}

export async function verifyRenderedPromptLive({
  baseUrl,
  messages,
  tools,
  timeoutMs = 30_000,
  signal,
}) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value < 1) throw new Error("CASE_TIME_CAP_EXCEEDED");
    return value;
  };
  const applied = await requestLoopbackJson({
    url: `${baseUrl}/apply-template`,
    method: "POST",
    body: { messages, tools },
    timeoutMs: remaining(),
    signal,
  });
  if (applied.status_code !== 200 || typeof applied.body?.prompt !== "string") {
    throw new Error("CHAT_TEMPLATE_RENDER_FAILED");
  }
  const tokenized = await requestLoopbackJson({
    url: `${baseUrl}/tokenize`,
    method: "POST",
    body: { content: applied.body.prompt, add_special: false, parse_special: true },
    timeoutMs: remaining(),
    signal,
  });
  const count = parseTokenizeResponse(tokenized.status_code, tokenized.body);
  return {
    ...verifyContextBudget(count.count, 1024, 8192),
    rendered_prompt_sha256: sha256Bytes(Buffer.from(applied.body.prompt, "utf8")),
    template_provenance: "llama-server-b10099-/apply-template",
  };
}

export async function tokenizeTextLive({
  baseUrl,
  text,
  timeoutMs = 30_000,
  signal,
}) {
  const response = await requestLoopbackJson({
    url: `${baseUrl}/tokenize`,
    method: "POST",
    body: { content: text, add_special: false, parse_special: true },
    timeoutMs,
    signal,
  });
  return parseTokenizeResponse(response.status_code, response.body);
}

export async function eraseSlotZero({
  baseUrl,
  timeoutMs = 30_000,
  signal,
}) {
  const response = await requestLoopbackJson({
    url: `${baseUrl}/slots/0?action=erase`,
    method: "POST",
    timeoutMs,
    signal,
  });
  return parseSlotEraseResponse(response.status_code, response.body);
}
