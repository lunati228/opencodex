import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleAssistantFromSse,
  verifyRuntimeBuildInfo,
} from "../src/http-live.mjs";

test("assistant assembly preserves indexed tool-call order and terminal server metrics", () => {
  const result = assembleAssistantFromSse({
    events: [
      { value: { choices: [{ delta: { reasoning_content: "think" } }] } },
      { value: { choices: [{ delta: { tool_calls: [
        { index: 1, id: "b", type: "function", function: { name: "get_", arguments: "{" } },
        { index: 0, id: "a", type: "function", function: { name: "read_", arguments: "{\"path\":" } },
      ] } }] } },
      { value: { choices: [{ delta: { tool_calls: [
        { index: 0, function: { name: "file", arguments: "\"x\"}" } },
        { index: 1, function: { name: "diff", arguments: "}" } },
      ] } }] } },
      { value: { choices: [], timings: { prompt_n: 3 }, usage: { prompt_tokens: 3 } } },
    ],
    terminal: { timings: { prompt_n: 3 }, usage: { prompt_tokens: 3 } },
  });
  assert.equal(result.reasoning_content, "think");
  assert.deepEqual(result.tool_calls.map((call) => call.id), ["a", "b"]);
  assert.equal(result.tool_calls[0].function.name, "read_file");
  assert.equal(result.tool_calls[0].function.arguments, "{\"path\":\"x\"}");
  assert.deepEqual(result.timings, { prompt_n: 3 });
  assert.deepEqual(result.usage, { prompt_tokens: 3 });
});

test("runtime identity pins either the official release marker or an explicit shallow-build marker", () => {
  assert.equal(
    verifyRuntimeBuildInfo(
      "b10099-1a064ab",
      "b10099",
      "1a064ab0921238c1daa397d6f4a900ef33884de2",
    ),
    "b10099-1a064ab",
  );
  assert.equal(
    verifyRuntimeBuildInfo(
      "b1-1a064ab",
      "b1-",
      "1a064ab0921238c1daa397d6f4a900ef33884de2",
    ),
    "b1-1a064ab",
  );
  assert.throws(
    () =>
      verifyRuntimeBuildInfo(
        "b1-deadbee",
        "b1-",
        "1a064ab0921238c1daa397d6f4a900ef33884de2",
      ),
    /SERVER_RUNTIME_IDENTITY_MISMATCH/,
  );
});
