import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  liveProcessEnvironment,
  runPinnedProcess,
} from "../src/process-live.mjs";
import { startWindowsProcessFamilyTracker } from "../src/windows-process-tree.mjs";
import { tempRoot } from "./temp-root.mjs";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function typeperfCsv(records) {
  const csv = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const counters = [
    ["ID Process", (record) => record.pid],
    ["Creating Process ID", (record) => record.parentPid],
    ["Elapsed Time", (record) => record.elapsedSeconds ?? 1],
  ];
  const headers = ["(PDH-CSV 4.0)"];
  const values = [new Date().toISOString()];
  for (const [counter, value] of counters) {
    for (const record of records) {
      headers.push(`\\\\HOST\\Process(${record.instance})\\${counter}`);
      values.push(String(value(record)));
    }
  }
  return `${headers.map(csv).join(",")}\r\n${values.map(csv).join(",")}\r\n`;
}

async function recordedTree(pidFile) {
  const [rootPid, descendantPid] = (await readFile(pidFile, "utf8"))
    .split(",")
    .map(Number);
  return { rootPid, descendantPid };
}

async function recordedTreeEventually(pidFile) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await recordedTree(pidFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("TREE_PID_FILE_NOT_WRITTEN");
}

function windowsCommandAdapter({
  pidFile,
  taskkill = "success",
  corruptInitial = false,
  corruptVerification = false,
  onTaskkill = () => {},
  onSnapshot = () => {},
}) {
  let snapshots = 0;
  return async ({ executable, args }) => {
    const name = path.basename(executable).toLowerCase();
    if (name === "typeperf.exe") {
      onSnapshot();
      assert.deepEqual(args, [
        "\\Process(*)\\ID Process",
        "\\Process(*)\\Creating Process ID",
        "\\Process(*)\\Elapsed Time",
        "-sc",
        "1",
      ]);
      snapshots += 1;
      if (corruptInitial && snapshots === 1) {
        return {
          closed: true,
          code: 0,
          signal: null,
          stdout: "\"broken\"\r\n",
          stderr: "",
        };
      }
      if (corruptVerification && snapshots > 1) {
        return {
          closed: true,
          code: 0,
          signal: null,
          stdout: "\"broken\"\r\n",
          stderr: "",
        };
      }
      const { rootPid, descendantPid } = await recordedTreeEventually(pidFile);
      const records = [
        { instance: "unrelated", pid: 999_999, parentPid: 0 },
      ];
      if (pidAlive(rootPid)) {
        records.push({
          instance: "root",
          pid: rootPid,
          parentPid: process.pid,
        });
      }
      if (pidAlive(descendantPid)) {
        records.push({
          instance: "descendant",
          pid: descendantPid,
          parentPid: rootPid,
        });
      }
      const stdout = typeperfCsv(records);
      return {
        closed: true,
        code: 0,
        signal: null,
        stdout,
        stderr: "",
      };
    }
    if (name === "taskkill.exe") {
      onTaskkill();
      const { rootPid, descendantPid } = await recordedTree(pidFile);
      assert.deepEqual(args, ["/PID", String(rootPid), "/T", "/F"]);
      if (taskkill === "throw") {
        throw new Error("injected taskkill spawn error");
      }
      if (taskkill === "failure") {
        return {
          closed: true,
          code: 5,
          signal: null,
          stdout: "",
          stderr: "Access is denied.",
        };
      }
      for (const pid of [descendantPid, rootPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      return {
        closed: true,
        code: 0,
        signal: null,
        stdout: "SUCCESS",
        stderr: "",
      };
    }
    throw new Error(`UNEXPECTED_SYSTEM_COMMAND: ${executable}`);
  };
}

function stubbornTreeScript() {
  return [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "writeFileSync(process.argv[1],`${process.pid},${child.pid}`);",
    "process.on('SIGTERM',()=>{});",
    "setInterval(()=>{},1000);",
  ].join("");
}

function orphaningTreeScript() {
  return [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "writeFileSync(process.argv[1],`${process.pid},${child.pid}`);",
    "setTimeout(()=>process.exit(0),100);",
  ].join("");
}

function quickExitScript() {
  return [
    "const {writeFileSync}=require('node:fs');",
    "writeFileSync(process.argv[1],String(process.pid));",
    "setTimeout(()=>process.exit(0),40);",
  ].join("");
}

async function readPidEventually(pidFile) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("PID_FILE_NOT_WRITTEN");
}

test("live process environment pins the multi-GPU CUDA launch queue hint", () => {
  const environment = liveProcessEnvironment({
    PATH: "C:\\Windows\\System32",
    CUDA_SCALE_LAUNCH_QUEUES: "1x",
  });
  assert.equal(environment.CUDA_SCALE_LAUNCH_QUEUES, "4x");
});

test("live process environment pins the CPU-resident weight offload threshold", () => {
  // A forged inherited value must not change a candidate: most of this
  // checkpoint is host-side and the second GPU is on a Gen3 x4 link, so the
  // default 32-token threshold pays transfers that never amortize.
  const environment = liveProcessEnvironment({
    PATH: "C:\\Windows\\System32",
    GGML_OP_OFFLOAD_MIN_BATCH: "1",
  });
  assert.equal(environment.GGML_OP_OFFLOAD_MIN_BATCH, "512");

  const inherited = liveProcessEnvironment({ PATH: "C:\\Windows\\System32" });
  assert.equal(inherited.GGML_OP_OFFLOAD_MIN_BATCH, "512");
});

test("live process environment never inherits MoE cache mode and pins each arm explicitly", () => {
  const inherited = liveProcessEnvironment({
    PATH: "C:\\Windows\\System32",
    GGML_CUDA_MOE_CACHE: "1",
  });
  assert.equal(inherited.GGML_CUDA_MOE_CACHE, undefined);
  assert.equal(
    liveProcessEnvironment(
      { PATH: "C:\\Windows\\System32", GGML_CUDA_MOE_CACHE: "0" },
      { moeCacheMode: "on" },
    ).GGML_CUDA_MOE_CACHE,
    "1",
  );
  assert.equal(
    liveProcessEnvironment(
      { PATH: "C:\\Windows\\System32", GGML_CUDA_MOE_CACHE: "1" },
      { moeCacheMode: "off" },
    ).GGML_CUDA_MOE_CACHE,
    "0",
  );
  assert.throws(
    () =>
      liveProcessEnvironment(
        { PATH: "C:\\Windows\\System32" },
        { moeCacheMode: "default" },
      ),
    /INVALID_MOE_CACHE_MODE/,
  );
});

test("live process environment accepts only explicit numeric cache-on settings", () => {
  const settings = {
    GGML_CUDA_MOE_CACHE_SELFTEST: "0",
    GGML_CUDA_MOE_CACHE_RESERVE_MB: "3072",
    GGML_CUDA_MOE_CACHE_WORKERS: "4",
  };
  const environment = liveProcessEnvironment(
    {
      PATH: "C:\\Windows\\System32",
      GGML_CUDA_MOE_CACHE_REUSE: "1",
    },
    { moeCacheMode: "on", moeCacheSettings: settings },
  );
  assert.equal(environment.GGML_CUDA_MOE_CACHE, "1");
  assert.equal(environment.GGML_CUDA_MOE_CACHE_SELFTEST, "0");
  assert.equal(environment.GGML_CUDA_MOE_CACHE_RESERVE_MB, "3072");
  assert.equal(environment.GGML_CUDA_MOE_CACHE_WORKERS, "4");
  assert.equal(environment.GGML_CUDA_MOE_CACHE_REUSE, undefined);
  assert.throws(
    () =>
      liveProcessEnvironment(
        {},
        { moeCacheMode: "off", moeCacheSettings: settings },
      ),
    /INVALID_MOE_CACHE_SETTINGS/,
  );
  assert.throws(
    () =>
      liveProcessEnvironment(
        {},
        {
          moeCacheMode: "on",
          moeCacheSettings: { PATH: "C:\\malicious" },
        },
      ),
    /INVALID_MOE_CACHE_SETTING/,
  );
});

test("pinned process passes only an explicit absolute router trace path", async () => {
  const root = await tempRoot("ornith-router-env-");
  const routerTracePath = path.join(root, "router.jsonl");
  const result = await runPinnedProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.env.GGML_ROUTER_TRACE_PATH ?? '')"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    routerTracePath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, routerTracePath);
  assert.deepEqual(result.command.environment, {
    GGML_ROUTER_TRACE_PATH: routerTracePath,
  });
  await assert.rejects(
    runPinnedProcess({
      executable: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      routerTracePath: "relative-router.jsonl",
    }),
    /INVALID_ROUTER_TRACE_PATH/,
  );
});

test("pinned process uses exact argv without shell interpretation", async () => {
  const result = await runPinnedProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", "x;echo PWNED"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "x;echo PWNED");
  assert.equal(result.command.shell, false);
});

test("pinned process exposes its exact spawned PID to the GPU identity guard", async () => {
  let observedPid = null;
  const result = await runPinnedProcess({
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{},25)"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    afterSpawn: async (pid) => {
      observedPid = pid;
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.pid, observedPid);
});

test("pinned process reports bounded truncation", async () => {
  const result = await runPinnedProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(100))"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxStdoutBytes: 10,
    maxStderrBytes: 10,
  });
  assert.equal(result.stdout, "xxxxxxxxxx");
  assert.equal(result.stdout_truncated, true);
});

test("timeout kills the exact stubborn process tree before returning", async () => {
  const root = await tempRoot("ornith-tree-success-");
  const pidFile = path.join(root, "tree-pids.txt");
  const result = await runPinnedProcess({
    executable: process.execPath,
    args: ["-e", stubbornTreeScript(), pidFile],
    cwd: process.cwd(),
    timeoutMs: 250,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    terminationRuntime: {
      systemCommandRunner: windowsCommandAdapter({ pidFile }),
    },
  });
  assert.equal(result.error_code, "COMMAND_TIMEOUT");
  const { rootPid, descendantPid } = await recordedTree(pidFile);
  assert.equal(pidAlive(rootPid), false);
  assert.equal(pidAlive(descendantPid), false);
});

test("abort kills the exact stubborn process tree before returning", async () => {
  const controller = new AbortController();
  const root = await tempRoot("ornith-tree-abort-");
  const pidFile = path.join(root, "tree-pids.txt");
  const pending = runPinnedProcess({
    executable: process.execPath,
    args: ["-e", stubbornTreeScript(), pidFile],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    signal: controller.signal,
    terminationRuntime: {
      systemCommandRunner: windowsCommandAdapter({ pidFile }),
    },
  });
  setTimeout(() => controller.abort(new Error("test abort")), 250);
  const result = await pending;
  assert.equal(result.error_code, "COMMAND_ABORTED");
  const { rootPid, descendantPid } = await recordedTree(pidFile);
  assert.equal(pidAlive(rootPid), false);
  assert.equal(pidAlive(descendantPid), false);
});

test("taskkill failure is fatal and production fallback kills the enumerated tree", async () => {
  for (const taskkill of ["failure", "throw"]) {
    const root = await tempRoot("ornith-taskkill-fail-");
    const pidFile = path.join(root, "tree-pids.txt");
    let recordedPids = [];
    try {
      await assert.rejects(
        runPinnedProcess({
          executable: process.execPath,
          args: ["-e", stubbornTreeScript(), pidFile],
          cwd: process.cwd(),
          timeoutMs: 250,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          terminationRuntime: {
            systemCommandRunner: windowsCommandAdapter({ pidFile, taskkill }),
          },
        }),
        /TASKKILL_TREE_TERMINATION_FAILED/,
      );
      recordedPids = (await readFile(pidFile, "utf8"))
        .split(",")
        .map(Number);
      for (const pid of recordedPids) {
        assert.throws(() => process.kill(pid, 0));
      }
    } finally {
      for (const pid of recordedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone is the expected state.
        }
      }
    }
  }
});

test("verification uncertainty is fatal after cleaning the enumerated tree", async () => {
  const root = await tempRoot("ornith-tree-verify-fail-");
  const pidFile = path.join(root, "tree-pids.txt");
  await assert.rejects(
    runPinnedProcess({
      executable: process.execPath,
      args: ["-e", stubbornTreeScript(), pidFile],
      cwd: process.cwd(),
      timeoutMs: 250,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      terminationRuntime: {
        systemCommandRunner: windowsCommandAdapter({
          pidFile,
          corruptVerification: true,
        }),
      },
    }),
    /WINDOWS_PROCESS_SNAPSHOT_INVALID|TASKKILL_TREE_TERMINATION_FAILED/,
  );
  const { rootPid, descendantPid } = await recordedTree(pidFile);
  for (const pid of [rootPid, descendantPid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The expected path already cleaned it.
    }
  }
});

test("initial snapshot failure still invokes exact taskkill and leaves the tree dead", async () => {
  const root = await tempRoot("ornith-tree-initial-fail-");
  const pidFile = path.join(root, "tree-pids.txt");
  let taskkillCalls = 0;
  await assert.rejects(
    runPinnedProcess({
      executable: process.execPath,
      args: ["-e", stubbornTreeScript(), pidFile],
      cwd: process.cwd(),
      timeoutMs: 250,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      terminationRuntime: {
        systemCommandRunner: windowsCommandAdapter({
          pidFile,
          corruptInitial: true,
          onTaskkill: () => {
            taskkillCalls += 1;
          },
        }),
      },
    }),
    /TASKKILL_TREE_TERMINATION_FAILED/,
  );
  const { rootPid, descendantPid } = await recordedTree(pidFile);
  assert.equal(taskkillCalls, 1);
  assert.equal(pidAlive(rootPid), false);
  assert.equal(pidAlive(descendantPid), false);
});

test("a descendant first observed after taskkill is retained, killed, and makes termination fatal", async () => {
  const root = await tempRoot("ornith-tree-late-child-");
  const pidFile = path.join(root, "tree-pids.txt");
  const late = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  let snapshots = 0;
  let taskkillRan = false;
  const commandRunner = async ({ executable, args }) => {
    const name = path.basename(executable).toLowerCase();
    const { rootPid, descendantPid } = await recordedTree(pidFile);
    if (name === "taskkill.exe") {
      assert.deepEqual(args, ["/PID", String(rootPid), "/T", "/F"]);
      taskkillRan = true;
      for (const pid of [descendantPid, rootPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      return {
        closed: true,
        code: 0,
        signal: null,
        stdout: "SUCCESS",
        stderr: "",
      };
    }
    assert.equal(name, "typeperf.exe");
    snapshots += 1;
    const records = [
      { instance: "unrelated", pid: 999_997, parentPid: 0 },
    ];
    if (!taskkillRan) {
      records.push(
        { instance: "root", pid: rootPid, parentPid: process.pid },
        { instance: "descendant", pid: descendantPid, parentPid: rootPid },
      );
    } else if (snapshots >= 3 && pidAlive(late.pid)) {
      records.push({
        instance: "late-descendant",
        pid: late.pid,
        parentPid: rootPid,
      });
    }
    return {
      closed: true,
      code: 0,
      signal: null,
      stdout: typeperfCsv(records),
      stderr: "",
    };
  };
  try {
    let terminationError = null;
    try {
      await runPinnedProcess({
        executable: process.execPath,
        args: ["-e", stubbornTreeScript(), pidFile],
        cwd: process.cwd(),
        timeoutMs: 250,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        terminationRuntime: { systemCommandRunner: commandRunner },
      });
    } catch (error) {
      terminationError = error;
    }
    assert.match(terminationError?.message ?? "", /TASKKILL_TREE_TERMINATION_FAILED/);
    const { rootPid, descendantPid } = await recordedTree(pidFile);
    assert.equal(pidAlive(rootPid), false);
    assert.equal(pidAlive(descendantPid), false);
    assert.equal(
      pidAlive(late.pid),
      false,
      `snapshots=${snapshots} error=${terminationError?.stack}`,
    );
    assert.ok(snapshots >= 6);
  } finally {
    for (const pid of [late.pid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Expected after retained-family cleanup.
      }
    }
  }
});

test("normal root exit still proves the retained PID family empty", async () => {
  const root = await tempRoot("ornith-tree-normal-exit-");
  const pidFile = path.join(root, "tree-pids.txt");
  let snapshots = 0;
  const result = await runPinnedProcess({
      executable: process.execPath,
      args: ["-e", orphaningTreeScript(), pidFile],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      retainProcessFamily: true,
      terminationRuntime: {
        systemCommandRunner: windowsCommandAdapter({
          pidFile,
          onSnapshot: () => {
            snapshots += 1;
          },
        }),
      },
    });
  const { rootPid, descendantPid } = await recordedTree(pidFile);
  assert.equal(result.ok, true);
  assert.ok(snapshots >= 3);
  assert.equal(pidAlive(rootPid), false);
  assert.equal(pidAlive(descendantPid), false);
});

test("retained-family close observation is installed before tracker initialization awaits", async () => {
  const root = await tempRoot("ornith-tree-fast-exit-");
  const pidFile = path.join(root, "root-pid.txt");
  let snapshots = 0;
  const systemCommandRunner = async ({ executable }) => {
    const name = path.basename(executable).toLowerCase();
    if (name === "typeperf.exe") {
      snapshots += 1;
      if (snapshots === 1) {
        const rootPid = await readPidEventually(pidFile);
        const stdout = typeperfCsv([
          { instance: "root", pid: rootPid, parentPid: process.pid },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          closed: true,
          code: 0,
          signal: null,
          stdout,
          stderr: "",
        };
      }
      return {
        closed: true,
        code: 0,
        signal: null,
        stdout: typeperfCsv([
          { instance: "unrelated", pid: 999_990, parentPid: 0 },
        ]),
        stderr: "",
      };
    }
    if (name === "taskkill.exe") {
      return {
        closed: true,
        code: 0,
        signal: null,
        stdout: "SUCCESS",
        stderr: "",
      };
    }
    throw new Error(`UNEXPECTED_SYSTEM_COMMAND: ${executable}`);
  };

  const result = await Promise.race([
    runPinnedProcess({
      executable: process.execPath,
      args: ["-e", quickExitScript(), pidFile],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      retainProcessFamily: true,
      terminationRuntime: { systemCommandRunner },
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("RUN_PINNED_PROCESS_CLOSE_OBSERVATION_HUNG")),
        750,
      )),
  ]);

  assert.equal(result.ok, true);
  assert.ok(snapshots >= 3);
});

test("tracker retries only a missing freshly spawned root, not corrupt snapshots", async () => {
  let snapshots = 0;
  await assert.rejects(
    startWindowsProcessFamilyTracker({
      child: { pid: 999_991 },
      environment: liveProcessEnvironment(process.env),
      runtime: {
        systemCommandRunner: async ({ executable }) => {
          assert.equal(path.basename(executable).toLowerCase(), "typeperf.exe");
          snapshots += 1;
          return {
            closed: true,
            code: 0,
            signal: null,
            stdout: "\"broken\"\r\n",
            stderr: "",
          };
        },
      },
    }),
    /WINDOWS_PROCESS_SNAPSHOT_INVALID/,
  );
  assert.equal(snapshots, 1);
});

test("tracker initialization failure cleans and proves the spawned tree before rejecting", async () => {
  const root = await tempRoot("ornith-tracker-init-fail-");
  const pidFile = path.join(root, "tree-pids.txt");
  let taskkillCalls = 0;
  await assert.rejects(
    runPinnedProcess({
      executable: process.execPath,
      args: ["-e", stubbornTreeScript(), pidFile],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      retainProcessFamily: true,
      terminationRuntime: {
        systemCommandRunner: windowsCommandAdapter({
          pidFile,
          corruptInitial: true,
          onTaskkill: () => {
            taskkillCalls += 1;
          },
        }),
      },
    }),
    /WINDOWS_PROCESS_SNAPSHOT_INVALID/,
  );
  const { rootPid, descendantPid } = await recordedTree(pidFile);
  assert.equal(taskkillCalls, 1);
  assert.equal(pidAlive(rootPid), false);
  assert.equal(pidAlive(descendantPid), false);
});
