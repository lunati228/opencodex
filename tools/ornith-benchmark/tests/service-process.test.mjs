import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempRoot } from "./temp-root.mjs";

import {
  startPinnedService,
  stopPinnedService,
} from "../src/service-process.mjs";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function snapshotCsv(records) {
  const csv = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const counters = [
    ["ID Process", (record) => record.pid],
    ["Creating Process ID", (record) => record.parentPid],
    ["Elapsed Time", () => 1],
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

async function readPidsEventually(pidFile) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return (await readFile(pidFile, "utf8")).split(",").map(Number);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("SERVICE_PID_FILE_NOT_WRITTEN");
}

test("Windows service stop cleans descendants but remains fatal when taskkill fails", async () => {
  const root = await tempRoot("ornith-service-tree-");
  const pidFile = path.join(root, "pids.txt");
  const script = [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "writeFileSync(process.argv[1],`${process.pid},${child.pid}`);",
    "process.on('SIGTERM',()=>{});",
    "setInterval(()=>{},1000);",
  ].join("");
  const commandRunner = async ({ executable, args }) => {
    const [rootPid, childPid] = await readPidsEventually(pidFile);
    if (path.basename(executable).toLowerCase() === "typeperf.exe") {
      const records = [
        { instance: "unrelated", pid: 999_998, parentPid: 0 },
      ];
      if (pidAlive(rootPid)) {
        records.push({ instance: "service", pid: rootPid, parentPid: process.pid });
      }
      if (pidAlive(childPid)) {
        records.push({ instance: "worker", pid: childPid, parentPid: rootPid });
      }
      return {
        closed: true,
        code: 0,
        signal: null,
        stdout: snapshotCsv(records),
        stderr: "",
      };
    }
    assert.equal(path.basename(executable).toLowerCase(), "taskkill.exe");
    assert.deepEqual(args, ["/PID", String(rootPid), "/T", "/F"]);
    return {
      closed: true,
      code: 5,
      signal: null,
      stdout: "",
      stderr: "Access is denied.",
    };
  };
  const service = await startPinnedService({
    executable: process.execPath,
    args: ["-e", script, pidFile],
    cwd: process.cwd(),
    terminationRuntime: { systemCommandRunner: commandRunner },
    retainProcessFamily: true,
  });
  let rootPid;
  let childPid;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        [rootPid, childPid] = (await readFile(pidFile, "utf8"))
          .split(",")
          .map(Number);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(Number.isSafeInteger(rootPid));
    assert.ok(Number.isSafeInteger(childPid));
    await assert.rejects(
      stopPinnedService(service),
      /TASKKILL_TREE_TERMINATION_FAILED/,
    );
    assert.equal(pidAlive(rootPid), false);
    assert.equal(pidAlive(childPid), false);
  } finally {
    for (const pid of [childPid, rootPid]) {
      if (!Number.isSafeInteger(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone is expected.
      }
    }
  }
});
