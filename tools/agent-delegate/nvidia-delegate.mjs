#!/usr/bin/env node
/**
 * Bounded delegation to an external NVIDIA-hosted model.
 *
 * Reads one protected provider bundle, sends a single non-streaming chat
 * completion, and writes a redacted result file. It exists so external-model
 * assistance is reproducible and auditable instead of ad hoc.
 *
 * Security properties (do not weaken):
 * - the credential path must resolve inside the protected secrets directory;
 * - symlinked credential or request files are refused;
 * - the key never enters argv, stdout, the result file, or any log;
 * - the endpoint must be the official NVIDIA HTTPS host;
 * - redirects are refused;
 * - the bundle must stay `disabled` + `liveModels:false` (static allowlist), so
 *   this tool can never widen routing;
 * - any `nvapi-` sequence in a response body is redacted before it is written.
 *
 * Usage:
 *   node tools/agent-delegate/nvidia-delegate.mjs <secret.json> <request.json> <out.json> [--validate-only]
 *
 * request.json: { "user": "...", "system"?: "...", "max_tokens"?, "temperature"?,
 *                 "top_p"?, "thinking"?, "timeout_ms"? }
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";

const [, , secretArg, requestArg, outputArg, modeArg] = process.argv;
if (!secretArg || !requestArg || !outputArg) {
  throw new Error(
    "Usage: node nvidia-delegate.mjs <secret-json> <request-json> <output-json> [--validate-only]",
  );
}

const secretRoot = path.resolve(
  process.env.OPENCODEX_PROVIDER_SECRETS
    ?? path.join(os.homedir(), ".opencodex", "provider-secrets"),
);
const outputRoot = path.resolve(
  process.env.OPENCODEX_DELEGATE_OUT
    ?? path.join(os.tmpdir(), "opencodex-delegate"),
);

const secretPath = path.resolve(secretArg);
const requestPath = path.resolve(requestArg);
const outputPath = path.resolve(outputArg);

function parseJsonFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  // Node's JSON.parse rejects a BOM; PowerShell writes one by default.
  return JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
}

function assertInside(candidate, root, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside ${root}`);
  }
}

assertInside(secretPath, secretRoot, "Secret file");
assertInside(outputPath, outputRoot, "Output file");
if (lstatSync(secretPath).isSymbolicLink()) throw new Error("Refusing a symbolic-link secret file");
if (lstatSync(requestPath).isSymbolicLink()) throw new Error("Refusing a symbolic-link request file");

const secretDocument = parseJsonFile(secretPath);
const providerEntries = Object.entries(secretDocument.providers ?? {});
if (providerEntries.length !== 1) {
  throw new Error("Credential container must define exactly one provider");
}

const [providerId, provider] = providerEntries[0];
if (provider.adapter !== "openai-chat" || provider.authMode !== "key") {
  throw new Error("Credential container is not an OpenAI-compatible key provider");
}
if (provider.disabled !== true || provider.liveModels !== false) {
  throw new Error("Credential container must remain disabled and static");
}
if (
  typeof provider.apiKey !== "string"
  || !provider.apiKey.startsWith("nvapi-")
  || provider.apiKey.length < 40
) {
  throw new Error("Credential has an unexpected NVIDIA API-key format");
}
if (
  typeof provider.defaultModel !== "string"
  || !Array.isArray(provider.models)
  || !provider.models.includes(provider.defaultModel)
) {
  throw new Error("Default model is not in the static model allowlist");
}

const configuredUrl = new URL(provider.baseUrl);
if (configuredUrl.protocol !== "https:" || configuredUrl.hostname !== "integrate.api.nvidia.com") {
  throw new Error("Provider endpoint is not the official NVIDIA HTTPS host");
}

const normalizedPath = configuredUrl.pathname.replace(/\/+$/, "");
let endpoint;
if (normalizedPath === "/v1") {
  endpoint = new URL("/v1/chat/completions", configuredUrl);
} else if (normalizedPath === "/v1/chat/completions") {
  endpoint = configuredUrl;
} else {
  throw new Error(`Unsupported NVIDIA endpoint path: ${configuredUrl.pathname}`);
}

const request = parseJsonFile(requestPath);
if (typeof request.user !== "string" || request.user.length === 0) {
  throw new Error("Request must contain a non-empty user prompt");
}
if (request.user.length > 250_000) {
  throw new Error("Request exceeds the 250,000-character safety cap");
}
if (
  request.system !== undefined
  && (typeof request.system !== "string" || request.system.length > 20_000)
) {
  throw new Error("System prompt must be a string of at most 20,000 characters");
}

const maxTokens = Math.min(Math.max(Number(request.max_tokens ?? 4096), 1), 16_384);
const temperature = Math.min(Math.max(Number(request.temperature ?? 0.2), 0), 1);
const topP = Math.min(Math.max(Number(request.top_p ?? 0.95), 0), 1);

const messages = [];
if (request.system) messages.push({ role: "system", content: request.system });
messages.push({ role: "user", content: request.user });

const body = {
  model: provider.defaultModel,
  messages,
  max_tokens: maxTokens,
  temperature,
  top_p: topP,
  seed: 42,
  stream: false,
};
if (provider.defaultModel === "deepseek-ai/deepseek-v4-pro") {
  body.chat_template_kwargs = { thinking: request.thinking === true };
}

mkdirSync(outputRoot, { recursive: true });
mkdirSync(path.dirname(outputPath), { recursive: true });

const metadata = {
  providerId,
  model: provider.defaultModel,
  endpointHost: endpoint.hostname,
  endpointPath: endpoint.pathname,
  validatedAt: new Date().toISOString(),
};

function writeAtomic(payload) {
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, outputPath);
}

if (modeArg === "--validate-only") {
  writeAtomic({ ...metadata, validationOnly: true });
  process.stdout.write(`validated provider=${providerId} model=${provider.defaultModel}\n`);
  process.exit(0);
}

const startedAt = performance.now();
let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(Number(request.timeout_ms ?? 180_000)),
  });
} catch (error) {
  // Deliberately reports only the error name: a message could echo the URL.
  throw new Error(`NVIDIA request failed before a response: ${error.name}`);
}

const durationMs = Math.round(performance.now() - startedAt);
const responseText = await response.text();
const redactedText = responseText.replace(/nvapi-[A-Za-z0-9_-]+/g, "[REDACTED]");

let parsed;
try {
  parsed = JSON.parse(redactedText);
} catch {
  parsed = { raw: redactedText.slice(0, 8_000) };
}

if (!response.ok) {
  writeAtomic({ ...metadata, ok: false, status: response.status, durationMs, error: parsed });
  throw new Error(`NVIDIA API returned HTTP ${response.status}`);
}

const choice = parsed?.choices?.[0]?.message;
writeAtomic({
  ...metadata,
  ok: true,
  status: response.status,
  durationMs,
  usage: parsed?.usage ?? null,
  finishReason: parsed?.choices?.[0]?.finish_reason ?? null,
  content: choice?.content ?? "",
  reasoningContent: choice?.reasoning_content ?? null,
});

process.stdout.write(
  `completed provider=${providerId} model=${provider.defaultModel} `
  + `status=${response.status} duration_ms=${durationMs}\n`,
);
