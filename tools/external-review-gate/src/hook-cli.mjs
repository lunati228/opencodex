#!/usr/bin/env node

const mode = process.argv[2];
const chunks = [];
let totalBytes = 0;
for await (const chunk of process.stdin) {
  chunks.push(chunk);
  totalBytes += chunk.length;
  if (totalBytes > 256 * 1024) {
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: "Review hook input exceeded its size limit.",
      }),
    );
    process.exit(0);
  }
}

let validInput = false;
try {
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  validInput =
    value !== null &&
    typeof value === "object" &&
    value.toolCall !== null &&
    typeof value.toolCall === "object";
} catch {
  validInput = false;
}

const output =
  mode === "deny-reviewer-tools" && validInput
    ? {
        decision: "deny",
        reason: "Reviewer sessions have no execution tools.",
      }
    : {
        decision: "deny",
        reason: "Review hook failed closed.",
      };
process.stdout.write(JSON.stringify(output));
