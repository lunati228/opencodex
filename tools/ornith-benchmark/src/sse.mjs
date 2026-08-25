function hasOutput(value) {
  const choices = Array.isArray(value?.choices) ? value.choices : [];
  return choices.some(({ delta }) => {
    if (!delta || typeof delta !== "object") return false;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
    if (typeof delta.content === "string" && delta.content.length > 0) return true;
    return Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) => {
      if (!call || typeof call !== "object") return false;
      return Boolean(
        (typeof call.id === "string" && call.id.length > 0) ||
        (typeof call.function?.name === "string" && call.function.name.length > 0) ||
        (typeof call.function?.arguments === "string" && call.function.arguments.length > 0),
      );
    });
  });
}

function eventData(block) {
  const lines = block.split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line === "data:") data.push("");
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return data.length ? data.join("\n") : null;
}

const MAX_PENDING_BYTES = 1024 * 1024;

export class SseAccumulator {
  constructor({
    maxBytes = 16 * 1024 * 1024,
    maxEvents = 100_000,
    nowNs = () => process.hrtime.bigint(),
  } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("INVALID_SSE_BYTE_CAP");
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("INVALID_SSE_EVENT_CAP");
    this.maxBytes = maxBytes;
    this.maxEvents = maxEvents;
    this.nowNs = nowNs;
    this.rawChunks = [];
    this.rawBytes = 0;
    this.pending = "";
    this.events = [];
    this.firstSseEventNs = null;
    this.firstOutputNs = null;
    this.terminal = null;
    this.done = false;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  push(chunk) {
    const bytes = Buffer.from(chunk);
    if (this.rawBytes + bytes.length > this.maxBytes) {
      throw new Error("SSE_BYTE_CAP_EXCEEDED");
    }
    this.rawChunks.push(bytes);
    this.rawBytes += bytes.length;
    this.pending += this.decoder.decode(bytes, { stream: true });
    const blocks = this.pending.split(/\r?\n\r?\n/);
    this.pending = blocks.pop();
    for (const block of blocks) {
      if (Buffer.byteLength(block) > MAX_PENDING_BYTES) {
        throw new Error("SSE_PENDING_BUFFER_EXCEEDED");
      }
      this.#acceptBlock(block);
    }
    if (Buffer.byteLength(this.pending) > MAX_PENDING_BYTES) {
      throw new Error("SSE_PENDING_BUFFER_EXCEEDED");
    }
  }

  #acceptBlock(block) {
    const data = eventData(block);
    if (data === null) return;
    if (data === "[DONE]") {
      this.done = true;
      return;
    }
    if (this.events.length >= this.maxEvents) {
      throw new Error("SSE_EVENT_CAP_EXCEEDED");
    }
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error("INVALID_SSE_JSON");
    }
    const timestampNs = this.nowNs();
    if (this.firstSseEventNs === null) this.firstSseEventNs = timestampNs;
    if (this.firstOutputNs === null && hasOutput(value)) {
      this.firstOutputNs = timestampNs;
    }
    if (value.timings && value.usage) this.terminal = value;
    this.events.push({ timestamp_ns: timestampNs, value });
  }

  finish() {
    this.pending += this.decoder.decode();
    if (Buffer.byteLength(this.pending) > MAX_PENDING_BYTES) {
      throw new Error("SSE_PENDING_BUFFER_EXCEEDED");
    }
    if (this.pending.trim().length > 0) this.#acceptBlock(this.pending);
    if (!this.terminal) throw new Error("SSE_TERMINAL_MISSING");
    if (!this.done) throw new Error("SSE_DONE_MISSING");
    return {
      raw: Buffer.concat(this.rawChunks),
      events: [...this.events],
      first_sse_event_ns: this.firstSseEventNs,
      first_output_ns: this.firstOutputNs,
      terminal: this.terminal,
      done: this.done,
    };
  }
}
