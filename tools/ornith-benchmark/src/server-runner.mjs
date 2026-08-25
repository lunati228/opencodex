import http from "node:http";
import path from "node:path";

import { appendRawArtifact } from "./artifacts.mjs";
import { checkLiveServer } from "./http-live.mjs";
import { buildServerArgv } from "./live-argv.mjs";
import { startPinnedService, stopPinnedService } from "./service-process.mjs";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function startOrnithServer({
  executable,
  model,
  serverModelId,
  port,
  candidate,
  cwd,
  loadTimeoutMs = 30 * 60_000,
  moeCacheMode,
}) {
  const args = buildServerArgv({ model, serverModelId, port, candidate });
  if (!["on", "off"].includes(moeCacheMode)) {
    throw new Error("FINAL_SERVER_REQUIRES_EXPLICIT_MOE_CACHE_MODE");
  }
  const service = await startPinnedService({
    executable,
    args,
    cwd,
    moeCacheMode,
    retainProcessFamily: true,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + loadTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (service.closed()) {
      throw new Error(`SERVER_EXITED_DURING_LOAD: ${service.closed().code}`);
    }
    try {
      const identity = await checkLiveServer({
        baseUrl,
        expectedModelId: serverModelId,
        expectedModelPath: model,
        expectedCommit: candidate.llama_commit,
      });
      return {
        service,
        base_url: baseUrl,
        identity,
        health_ready_ns: process.hrtime.bigint(),
        load_duration_ms: Number(process.hrtime.bigint() - service.started_ns) / 1e6,
      };
    } catch (error) {
      if (
        /SERVER_MODEL_IDENTITY_MISMATCH|SERVER_RUNTIME_IDENTITY_MISMATCH/.test(
          error.message,
        )
      ) {
        await stopPinnedService(service);
        throw error;
      }
      lastError = error;
      await delay(500);
    }
  }
  await stopPinnedService(service);
  throw new Error(`SERVER_HEALTH_TIMEOUT: ${lastError?.message ?? "unknown"}`);
}

async function requestGracefulServerShutdown(
  baseUrl,
  service,
  { requestTimeoutMs = 5_000, exitGraceMs = 5_000 } = {},
) {
  const target = new URL("/shutdown", baseUrl);
  if (target.hostname !== "127.0.0.1") {
    throw new Error("SERVER_SHUTDOWN_TARGET_NOT_LOOPBACK");
  }
  const requested = await new Promise((resolve) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: Number(target.port),
      path: target.pathname,
      method: "POST",
      headers: { Host: `127.0.0.1:${target.port}`, "Content-Length": "0" },
    });
    const timer = setTimeout(() => {
      request.destroy();
      resolve(false);
    }, requestTimeoutMs);
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => {
        clearTimeout(timer);
        resolve(response.statusCode >= 200 && response.statusCode < 300);
      });
    });
    request.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    request.end();
  });
  if (!requested) return false;
  const deadline = Date.now() + exitGraceMs;
  while (Date.now() < deadline) {
    if (service.closed()) return true;
    await delay(50);
  }
  return Boolean(service.closed());
}

export async function stopOrnithServer(
  server,
  artifactDirectory,
  {
    requestGracefulShutdown = requestGracefulServerShutdown,
    stopService = stopPinnedService,
  } = {},
) {
  await requestGracefulShutdown(server.base_url, server.service);
  const exit = await stopService(server.service);
  const capture = server.service.capture();
  await Promise.all([
    appendRawArtifact(path.join(artifactDirectory, "server.stdout.txt"), capture.stdout),
    appendRawArtifact(path.join(artifactDirectory, "server.stderr.txt"), capture.stderr),
    appendRawArtifact(
      path.join(artifactDirectory, "server.command.json"),
      Buffer.from(`${JSON.stringify(server.service.command, null, 2)}\n`),
    ),
  ]);
  if (capture.stdout_truncated || capture.stderr_truncated) {
    throw new Error("SERVER_LOG_TRUNCATED");
  }
  return exit;
}
