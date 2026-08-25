/**
 * Phase 5 acceptance for the managed local runtime.
 *
 * Launches llama-server from the exact argv the production profile emits, so
 * this verifies the shipped code path rather than a hand-written command line.
 * Proves readiness, model identity, a real completion, structured tool calling,
 * clean shutdown, and no orphaned process or listener -- then repeats the whole
 * cycle to prove the server can be started and stopped more than once.
 *
 * Usage:
 *   bun tools/release-gate/verify-local-runtime.ts [--ctx 196608] [--cycles 2]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  LOCAL_RUNTIME_HOST,
  LOCAL_RUNTIME_MODEL_ID,
  LOCAL_RUNTIME_PORT,
  LOCAL_RUNTIME_PROFILE_ID,
  buildLocalRuntimeArgs,
  buildLocalRuntimeEnvironment,
} from "../../src/local-runtime/profile";
import { loadPrivateLocalRuntimeProfile } from "../../src/local-runtime/private-profile";

const argv = process.argv.slice(2);
const readFlag = (name: string, fallback: number): number => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const nCtx = readFlag("--ctx", 196_608);
const cycles = readFlag("--cycles", 2);
const privateProfile = loadPrivateLocalRuntimeProfile(LOCAL_RUNTIME_PROFILE_ID);
const READY_TIMEOUT_MS = 600_000;
const base = `http://${LOCAL_RUNTIME_HOST}:${LOCAL_RUNTIME_PORT}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
}

function listenerPids(): number[] {
  const result = spawnSync("netstat.exe", ["-ano"], { encoding: "utf8", windowsHide: true });
  const pattern = new RegExp(`^\\s*TCP\\s+\\S*:${LOCAL_RUNTIME_PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "gm");
  return [...(result.stdout ?? "").matchAll(pattern)].map(m => Number(m[1]));
}

function llamaServerPids(): number[] {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "(Get-Process -Name llama-server -ErrorAction SilentlyContinue).Id"],
    { encoding: "utf8", windowsHide: true },
  );
  return (result.stdout ?? "").split(/\r?\n/).map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
}

function killTree(pid: number): void {
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 30_000 });
}

async function getJson(path: string): Promise<any> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

async function waitReady(child: ChildProcess): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const started = Date.now();
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
      if (health.ok) return Date.now() - started;
    } catch {
      // Loading returns non-200 or refuses connections; both are expected.
    }
    await Bun.sleep(2_000);
  }
  throw new Error("readiness timeout");
}

async function runCycle(cycle: number): Promise<void> {
  console.log(`\n=== cycle ${cycle}/${cycles} at ctx ${nCtx} ===`);

  const preexisting = listenerPids();
  check("port free before start", preexisting.length === 0, preexisting.join(",") || "none");
  if (preexisting.length > 0) return;

  const args = buildLocalRuntimeArgs(
    { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx },
    privateProfile,
  );
  const child = spawn(privateProfile.executablePath, args, {
    cwd: privateProfile.releaseRoot,
    env: buildLocalRuntimeEnvironment(privateProfile) as NodeJS.ProcessEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", c => { log += c.toString(); });
  child.stderr.on("data", c => { log += c.toString(); });

  try {
    const loadMs = await waitReady(child);
    check("server became ready", true, `${(loadMs / 1000).toFixed(1)}s load`);

    const owners = listenerPids();
    check("this process owns the listener", owners.length === 1 && owners[0] === child.pid,
      `listener=${owners.join(",")} child=${child.pid}`);

    const models = await getJson("/v1/models");
    const ids: string[] = (models.data ?? []).map((m: any) => m?.id);
    check("/v1/models advertises the alias", ids.includes(LOCAL_RUNTIME_MODEL_ID), ids.join(",") || "none");

    const props = await getJson("/props");
    const generation = props.default_generation_settings ?? {};
    check("effective n_ctx matches request", generation.n_ctx === nCtx, `got ${generation.n_ctx}`);
    check("exactly one slot", props.total_slots === 1, `got ${props.total_slots}`);
    const buildInfo = String(props.build_info ?? "");
    check(
      "build matches the private pinned identity",
      buildInfo.includes(privateProfile.expectedBuildNumber)
        && buildInfo.includes(privateProfile.expectedBuildCommit),
      buildInfo,
    );
    check("serving the verified model path",
      String(props.model_path ?? "").toLowerCase() === privateProfile.modelPath.toLowerCase(),
      String(props.model_path ?? ""));

    // Real completion, with throughput measured from the server's own timings.
    const started = Date.now();
    const completion = await (await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_RUNTIME_MODEL_ID,
        messages: [{ role: "user", content: "Reply with exactly: OPENCODEX_OK" }],
        max_tokens: 64,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(300_000),
    })).json();
    const wallMs = Date.now() - started;
    const text: string = completion?.choices?.[0]?.message?.content ?? "";
    const usage = completion?.usage ?? {};
    const tokPerSec = usage.completion_tokens && wallMs
      ? (usage.completion_tokens / (wallMs / 1000)).toFixed(2)
      : "n/a";
    check("completion returned text", text.trim().length > 0,
      `${usage.completion_tokens ?? "?"} tok, ${(wallMs / 1000).toFixed(1)}s, ~${tokPerSec} tok/s`);
    check("completion content is sane", text.includes("OPENCODEX_OK"), JSON.stringify(text.slice(0, 120)));

    // Structured tool calling: the whole point of using this model for agentic work.
    const toolCall = await (await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_RUNTIME_MODEL_ID,
        messages: [{ role: "user", content: "What is the weather in Berlin? Use the tool." }],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string", description: "City name" } },
              required: ["city"],
            },
          },
        }],
        tool_choice: "auto",
        max_tokens: 512,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(300_000),
    })).json();
    const calls = toolCall?.choices?.[0]?.message?.tool_calls ?? [];
    const first = calls[0];
    check("model emitted a structured tool call", calls.length > 0, `${calls.length} call(s)`);
    if (first) {
      check("tool call names the right function", first.function?.name === "get_weather", String(first.function?.name));
      let parsed: any = null;
      try { parsed = JSON.parse(first.function?.arguments ?? "{}"); } catch { /* reported below */ }
      check("tool arguments are valid JSON with the city",
        parsed !== null && typeof parsed.city === "string" && /berlin/i.test(parsed.city),
        JSON.stringify(first.function?.arguments ?? "").slice(0, 120));
    }
  } finally {
    if (child.pid) killTree(child.pid);
    await Bun.sleep(4_000);
    const leftoverListener = listenerPids();
    const leftoverProcess = llamaServerPids();
    check("no listener remains after stop", leftoverListener.length === 0, leftoverListener.join(",") || "none");
    check("no llama-server process remains", leftoverProcess.length === 0, leftoverProcess.join(",") || "none");
    if (failures > 0 && log) {
      console.log("\n--- last 1500 chars of server log ---");
      console.log(log.slice(-1500));
    }
  }
}

if (!existsSync(privateProfile.executablePath)) throw new Error("private runtime executable is missing");
if (!existsSync(privateProfile.modelPath)) throw new Error("private runtime model is missing");

for (let cycle = 1; cycle <= cycles; cycle += 1) {
  await runCycle(cycle);
}

console.log(`\n${failures === 0 ? "LOCAL_RUNTIME_ACCEPTANCE_PASS" : `LOCAL_RUNTIME_ACCEPTANCE_FAIL failures=${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
