import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  startTelemetryCapture,
  stopTelemetryCapture,
} from "../src/telemetry-capture.mjs";
import { TELEMETRY_CSV_HEADER } from "../src/artifacts.mjs";
import { tempRoot } from "./temp-root.mjs";

function fakeHungService() {
  let close;
  let closed = null;
  const wait = new Promise((resolve) => {
    close = resolve;
  });
  return {
    closed: () => closed,
    wait: () => wait,
    capture: () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdout_truncated: false,
      stderr_truncated: false,
    }),
    stop() {
      closed = { code: null, signal: "SIGKILL" };
      close(closed);
      return closed;
    },
  };
}

test("verified intentional Windows stops may return nonzero process exit codes", async () => {
  const now = process.hrtime.bigint();
  const captureStartedNs = now - 2_000_000_000n;
  const clocks = [now - 1_500_000_000n, now - 500_000_000n];
  const emptyCapture = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdout_truncated: false,
    stderr_truncated: false,
  };
  const service = {
    closed: () => null,
    capture: () => emptyCapture,
  };
  const root = await tempRoot("ornith-intentional-stop-");
  const rawDirectory = path.join(root, "raw");
  await mkdir(rawDirectory);
  await writeFile(
    path.join(root, "telemetry.csv"),
    `${TELEMETRY_CSV_HEADER}\n`,
  );
  const summary = await stopTelemetryCapture(
    {
      query: service,
      dmon: service,
      host: service,
      markStopping() {},
      stopService: async () => ({
        code: 1,
        signal: null,
        ended_ns: process.hrtime.bigint(),
      }),
      queryLines: { finish() {} },
      dmonLines: { finish() {} },
      hostLines: { finish() {} },
      fatalError: () => null,
      clocks,
      dmonClocks: clocks,
      hostClocks: clocks,
      captureStartedNs,
      expectedGpuMapping: [
        { backend_device: "CUDA0", gpu_index: 0, gpu_uuid: "GPU-A" },
      ],
      gpuClocks: new Map([["GPU-A", clocks]]),
      dmonIdentityTracker: {
        clocksByUuid: new Map([["GPU-A", clocks]]),
      },
      seenGpuUuids: new Set(["GPU-A"]),
      rows: clocks.map(() => ({
        gpu_uuid: "GPU-A",
        temperature_c: 30,
        power_w: 10,
        sm_clock_mhz: 300,
        pcie_gen_current: 1,
        pcie_width_current: 16,
        vram_used_mib: 100,
        request_in_flight: false,
      })),
      dmonSamples: [{ pci: 0, sbecc: 0, dbecc: 0, pviol: 0 }],
      hostSamples: [
        {
          committed_pct: 25,
          available_bytes: 24_000_000_000,
          pages_input_per_sec: 0,
          page_reads_per_sec: 0,
        },
      ],
    },
    { candidateRoot: root, rawDirectory },
  );
  assert.equal(summary.samples, 2);
  assert.equal(summary.host_summary.samples, 1);
});

test("a real watchdog timer aborts hung monitors and cleanup stops all services promptly", async () => {
  const services = [];
  let stopCount = 0;
  const abortController = new AbortController();
  const startedAt = performance.now();
  const capture = await startTelemetryCapture({
    nvidiaSmi: "C:\\fake\\nvidia-smi.exe",
    hostMonitor: "C:\\fake\\typeperf.exe",
    cwd: process.cwd(),
    metadata: {
      campaign_id: "watchdog-test",
      run_id: "run",
      candidate_id: "candidate",
      phase: "sweep",
    },
    abortTemperatureC: 80,
    abortController,
    expectedGpuMapping: [
      { backend_device: "CUDA0", gpu_index: 0, gpu_uuid: "GPU-A" },
      { backend_device: "CUDA1", gpu_index: 1, gpu_uuid: "GPU-B" },
    ],
    expectedPhysicalBytes: 1,
    maximumGapMs: 30,
    serviceRuntime: {
      startPinnedService: async () => {
        const service = fakeHungService();
        services.push(service);
        return service;
      },
      stopPinnedService: async (service) => {
        stopCount += 1;
        return service.stop();
      },
    },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("watchdog did not abort promptly")),
      1_000,
    );
    abortController.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  assert.match(
    abortController.signal.reason.message,
    /TELEMETRY_WATCHDOG_STALE/,
  );
  const root = await tempRoot("ornith-watchdog-stop-");
  await assert.rejects(
    stopTelemetryCapture(capture, {
      candidateRoot: root,
      rawDirectory: path.join(root, "raw"),
    }),
    /TELEMETRY_FATAL|INSUFFICIENT_TELEMETRY/,
  );
  assert.equal(services.length, 3);
  assert.equal(stopCount, 3);
  assert.ok(
    performance.now() - startedAt < 1_000,
    "watchdog cleanup exceeded one second",
  );
});

test("an overlong newline-free telemetry record aborts and cleans the started monitor", async () => {
  const services = [];
  let stopCount = 0;
  const abortController = new AbortController();
  await assert.rejects(
    startTelemetryCapture({
      nvidiaSmi: "C:\\fake\\nvidia-smi.exe",
      hostMonitor: "C:\\fake\\typeperf.exe",
      cwd: process.cwd(),
      metadata: {
        campaign_id: "overflow-test",
        run_id: "run",
        candidate_id: "candidate",
        phase: "sweep",
      },
      abortTemperatureC: 80,
      abortController,
      expectedGpuMapping: [
        { backend_device: "CUDA0", gpu_index: 0, gpu_uuid: "GPU-A" },
      ],
      expectedPhysicalBytes: 1,
      maximumGapMs: 5_000,
      serviceRuntime: {
        startPinnedService: async ({ onStdout }) => {
          const service = fakeHungService();
          services.push(service);
          onStdout(Buffer.alloc(1024 * 1024 + 1, 0x78));
          return service;
        },
        stopPinnedService: async (service) => {
          stopCount += 1;
          return service.stop();
        },
      },
    }),
    /TELEMETRY_LINE_BUFFER_OVERFLOW/,
  );
  assert.equal(abortController.signal.aborted, true);
  assert.match(
    abortController.signal.reason.message,
    /TELEMETRY_LINE_BUFFER_OVERFLOW/,
  );
  assert.equal(services.length, 1);
  assert.equal(stopCount, 1);
  assert.notEqual(services[0].closed(), null);
});
