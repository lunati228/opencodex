import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256File } from "./hash.mjs";

export const ROUNDS_CSV_HEADER =
  "schema_version,campaign_id,run_id,candidate_id,phase,case_id,round_index,started_at_utc,llama_tag,llama_commit,server_sha256,model_sha256,host_id,load_mode,use_mmap,use_direct_io,fit,device_order,gpu_uuid_order,pci_bus_order,split_mode,experimental,tensor_split,n_gpu_layers,n_cpu_moe,ctx_size,generation_cap,batch,ubatch,threads,threads_batch,cpu_mask,cpu_strict,priority,poll,flash_attn,cache_type_k,cache_type_v,kv_offload,op_offload,cache_ram_mib,spec_type,reasoning_format,reasoning_budget,seed,temperature,top_p,min_p,top_k,prompt_target,gen_target,cache_n,prompt_n,prompt_ms,prefill_tok_s,predicted_n,predicted_ms,decode_tok_s,ttft_ms,post_upload_ttft_ms,total_wall_ms,reasoning_tokens,answer_tokens,tool_call_count,tool_round_index,tool_latency_ms_sum,tool_round_wall_ms,normal_speed_sample,outcome,tests_passed,tests_total,unauthorized_change,malformed_tool_call,retry_count,gpu_temp_c_max,gpu_power_w_avg,gpu_clock_mhz_p50,pcie_gen_min_active,pcie_width_min_active,pcie_rx_mb_s_p95,pcie_tx_mb_s_p95,vram_mib_max,thermal_throttle_seen,abort_reason";

export const TELEMETRY_CSV_HEADER =
  "schema_version,campaign_id,run_id,candidate_id,phase,timestamp_utc,monotonic_ns,gpu_uuid,pci_bus_id,temperature_c,power_w,sm_clock_mhz,mem_clock_mhz,vram_used_mib,vram_total_mib,gpu_util_pct,mem_util_pct,pcie_gen_current,pcie_width_current,pcie_rx_mb_s,pcie_tx_mb_s,thermal_throttle,power_throttle,ecc_or_replay_error,request_in_flight";

const ROUND_FIELDS = Object.freeze(ROUNDS_CSV_HEADER.split(","));

function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

async function assertHeaderOnHandle(handle, expectedHeader) {
  const expected = Buffer.from(`${expectedHeader}\n`, "utf8");
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.size < expected.length) {
    throw new Error("APPEND_CSV_HEADER_INVALID");
  }
  const observed = Buffer.alloc(expected.length);
  const { bytesRead } = await handle.read(
    observed,
    0,
    observed.length,
    0,
  );
  if (
    bytesRead !== expected.length ||
    !observed.equals(expected)
  ) {
    throw new Error("APPEND_CSV_HEADER_INVALID");
  }
  return metadata.size;
}

export async function assertAppendCsvHeader(filePath, expectedHeader) {
  const handle = await open(filePath, "r");
  try {
    await assertHeaderOnHandle(handle, expectedHeader);
  } finally {
    await handle.close();
  }
}

export async function appendCsvRecords(filePath, expectedHeader, text) {
  if (typeof text !== "string" || text.length < 1) {
    throw new Error("APPEND_CSV_RECORDS_EMPTY");
  }
  const handle = await open(filePath, "r+");
  try {
    const end = await assertHeaderOnHandle(handle, expectedHeader);
    const bytes = Buffer.from(text, "utf8");
    const { bytesWritten } = await handle.write(
      bytes,
      0,
      bytes.length,
      end,
    );
    if (bytesWritten !== bytes.length) {
      throw new Error("APPEND_CSV_WRITE_INCOMPLETE");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendRoundRecords(filePath, records) {
  if (!Array.isArray(records) || records.length < 1) {
    throw new Error("ROUND_RECORD_SET_EMPTY");
  }
  const lines = records.map((record) =>
    ROUND_FIELDS.map((field) => csvField(record[field])).join(","),
  );
  await appendCsvRecords(
    filePath,
    ROUNDS_CSV_HEADER,
    `${lines.join("\n")}\n`,
  );
}

export function candidateAppendStreamPaths(candidateRoot) {
  return [
    {
      path: path.join(candidateRoot, "rounds.csv"),
      header: ROUNDS_CSV_HEADER,
    },
    {
      path: path.join(candidateRoot, "telemetry.csv"),
      header: TELEMETRY_CSV_HEADER,
    },
  ];
}

export async function ensureCandidateAppendStreams(
  candidateRoot,
  { allowCreate = false } = {},
) {
  const streams = candidateAppendStreamPaths(candidateRoot);
  const existence = await Promise.all(
    streams.map(async (stream) => {
      try {
        const metadata = await lstat(stream.path);
        return metadata.isFile() && !metadata.isSymbolicLink();
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }),
  );
  if (existence.every((value) => !value) && allowCreate) {
    await Promise.all(
      streams.map(({ path: filePath, header }) =>
        writeFile(filePath, `${header}\n`, { flag: "wx" })),
    );
  } else if (existence.some((value) => !value)) {
    throw new Error("CANDIDATE_APPEND_STREAM_SET_INCOMPLETE");
  }
  for (const { path: filePath, header } of streams) {
    await assertAppendCsvHeader(filePath, header);
  }
  return streams.map(({ path: filePath }) => filePath);
}

export function protocolRelativePaths(candidateId) {
  const base = `candidates/${candidateId}`;
  return [
    "campaign.json",
    "inventory/versions.txt",
    "inventory/hashes.sha256",
    "inventory/devices.txt",
    "inventory/gpu-topology.txt",
    "inventory/host.txt",
    `${base}/config.json`,
    `${base}/sweep/pp2k.raw.json`,
    `${base}/sweep/tg256-d2k.raw.json`,
    `${base}/final/pp8k.raw.json`,
    `${base}/final/tg1024-d8k.raw.json`,
    `${base}/final/pp16k.raw.json`,
    `${base}/final/tg1024-d16k.raw.json`,
    `${base}/server/cold`,
    `${base}/server/warm`,
    `${base}/server/sustained`,
    `${base}/rounds.csv`,
    `${base}/telemetry.csv`,
    `${base}/result.json`,
    "decision.json",
  ];
}

export async function createCampaignLayout(resultRoot, candidateId) {
  const candidateRoot = path.join(resultRoot, "candidates", candidateId);
  await Promise.all([
    mkdir(path.join(resultRoot, "inventory"), { recursive: true }),
    mkdir(path.join(candidateRoot, "sweep"), { recursive: true }),
    mkdir(path.join(candidateRoot, "final"), { recursive: true }),
    mkdir(path.join(candidateRoot, "server", "cold"), { recursive: true }),
    mkdir(path.join(candidateRoot, "server", "warm"), { recursive: true }),
    mkdir(path.join(candidateRoot, "server", "sustained"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(candidateRoot, "rounds.csv"), `${ROUNDS_CSV_HEADER}\n`, {
      flag: "wx",
    }),
    writeFile(
      path.join(candidateRoot, "telemetry.csv"),
      `${TELEMETRY_CSV_HEADER}\n`,
      { flag: "wx" },
    ),
  ]);
  return {
    resultRoot,
    candidateRoot,
    relativePaths: protocolRelativePaths(candidateId),
  };
}

export async function appendRawArtifact(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  let handle;
  try {
    handle = await open(filePath, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") {
      const immutable = new Error(`RAW_ARTIFACT_EXISTS: ${filePath}`);
      immutable.code = "RAW_ARTIFACT_EXISTS";
      throw immutable;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeDerivedJson(
  filePath,
  value,
  rawInputs,
  { keyRoot } = {},
) {
  const rawSha256 = {};
  for (const rawInput of rawInputs) {
    const key = keyRoot
      ? path.relative(keyRoot, rawInput).replaceAll("\\", "/")
      : path.basename(rawInput);
    if (
      key.length === 0 ||
      key === ".." ||
      key.startsWith("../") ||
      path.isAbsolute(key) ||
      Object.hasOwn(rawSha256, key)
    ) {
      throw new Error("DERIVED_RAW_KEY_COLLISION");
    }
    rawSha256[key] = await sha256File(rawInput);
  }
  const derived = { ...value, raw_sha256: rawSha256 };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(derived, null, 2)}\n`, {
    flag: "wx",
  });
}
