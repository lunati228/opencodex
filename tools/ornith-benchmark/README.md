# Ornith benchmark harness

> **Paused historical harness (2026-07-29):** preserve code, configuration
> examples, and tests. Do not launch Ornith benchmarks or resume tuning without
> a new explicit scope.

Dependency-free Node.js 24 tooling for the pinned local Ornith benchmark
protocol. It does not install packages and does not start a model or server
during `dry-run` or `preflight`.

## Commands

Copy `config/ornith-local.example.json`, replace every metavariable, then run:

```powershell
.\Invoke-OrnithBenchmark.ps1 Preflight -Config .\config\ornith-local.json
.\Invoke-OrnithBenchmark.ps1 DryRun -Config .\config\ornith-local.json
.\Invoke-OrnithBenchmark.ps1 PlanLive -Config .\config\ornith-local.json
```

Normal preflight first verifies the pinned llama.cpp runtime closure manifest,
then hashes every one of its exact flat release files from the physical
`releases\b10099` directory. Missing, extra, changed, nested, reparse-point, or
`.gguf` entries are fatal. The manifest itself lives in the adjacent
`llama.cpp\manifests` directory so it cannot be part of the file set it
describes. Preflight also hashes the small pinned model
`INSTALL-MANIFEST.json`, compares its repository revision, model pathname,
byte length, recorded model SHA-256, and verification timestamp, then performs
a fresh filesystem stat of the model. It never rehashes the 119.5 GB model.

The machine-local b10099 closure can be created once, without downloading
anything, from the already verified installation:

```powershell
node .\scripts\create-runtime-manifest.mjs `
  --runtime-root "<private-runtime-root>" `
  --install-manifest "<private-runtime-root>\INSTALL-MANIFEST.json" `
  --output "<private-runtime-root>\manifests\runtime.json"
```

The generator refuses to overwrite an existing manifest and checks the
audited 55-file count, 700,841,136-byte total, official archive provenance,
and ordinal content-set digest before writing.

The cache-enabled source build is deliberately a different provenance type.
After an operator assembles its separate flat runtime, generate its manifest
without claiming that it came from an official prebuilt archive:

```powershell
node .\scripts\create-cache-runtime-manifest.mjs `
  --runtime-root "<ABSOLUTE_15_FILE_CACHE_RUNTIME>" `
  --build-record "<ABSOLUTE_BUILD_RECORD>" `
  --build-record-sha256 "<SHA256>" `
  --toolchain-evidence "<ABSOLUTE_TOOLCHAIN_EVIDENCE_JSON>" `
  --toolchain-evidence-sha256 "<SHA256>" `
  --output "<ABSOLUTE_MANIFEST_OUTSIDE_RUNTIME_ROOT>"
```

This generator requires the exact repaired 15-file, 588,472,544-byte closure.
It binds the runtime identity to the b10099 base commit `1a064ab...` embedded
by CMake and reported by `--version`, while retaining the verified local repair
commit `3f7eadbe...` separately in source-build provenance. It hash-verifies
the build record and toolchain evidence before writing and uses create-new
semantics.

`-HashFiles` is an explicit, expensive re-verification mode. It hashes every
required input including the model and must not be used as a routine first
step.

`PlanLive` emits the exact short/final `llama-bench` argv and exact
loopback-only `llama-server` argv without launching anything or writing output.
The plan includes `-ncmoe`/`--n-cpu-moe`, `--alias`, explicit device order,
load mode, offload settings, `--fit off`, and `--spec-type none`.

## Short sweep execution

The live short-sweep command is intentionally separate and requires an
explicit confirmation flag:

```powershell
.\Invoke-OrnithBenchmark.ps1 RunShortSweep -Config .\config\ornith-local.json
```

Before launch it performs normal no-model-rehash preflight, freshly verifies
the complete content-addressed b10099 runtime closure and entrypoint digests,
verifies free result-volume space, and enforces the predeclared CPU-MoE order
`60,58,56,54,52,50,48`. It then captures 60 seconds of pre-roll telemetry,
runs only the exact 2K/256 three-repetition pair, captures 30 seconds of
post-roll telemetry, and writes immutable stdout, stderr, command, and raw
telemetry artifacts plus a hash-bound summary. Both roll waits are
abort-aware: monitor exit or a safety abort cancels the timer immediately and
enters telemetry cleanup instead of waiting for the nominal boundary.

Every live child receives the pinned multi-GPU hint
`CUDA_SCALE_LAUNCH_QUEUES=4x`; an inherited value cannot silently change a
candidate.

Completed candidate units are resumable only after all recorded artifact
hashes verify. Before any resume or predecessor hash is read, the complete
artifact set must match the short-sweep allowlist exactly, remain beneath the
configured absolute result root without a reparse point, be a regular file,
and remain below its per-artifact size ceiling. The predecessor's hash-bound
`config.json` must also declare the expected candidate ID, sweep index,
`n_cpu_moe`, sweep order, and identical non-CPU-MoE comparison config. A
partial unit is rejected rather than overwritten. Use a new candidate
ID/result location for an interrupted partial attempt.

## Telemetry and hard aborts

The local live config must pin `expected_physical_memory_bytes` to
`34191171584` for this host. Immediately before a short sweep, the runner
compares that value with a fresh OS total-memory reading and refuses a
mismatch.

### Host reserve (`live.host_reserve`)

How much host RAM stays out of the benchmark's reach, and when commit pressure
aborts a run. Optional — omitting it reproduces the built-in defaults exactly.

| Field | Meaning | Default |
|---|---|---|
| `available_reserve_gib` | RAM kept free for the desktop; abort if available falls below it | none (fraction floor only) |
| `available_floor_fraction` | Same idea as a fraction of total RAM; the stricter of the two applies | `0.05` |
| `sustained_seconds` | Seconds continuously below the floor before aborting | `30` |
| `committed_abort_pct` | Windows commit-charge hard abort, no grace window | `95` |

Units are GiB and seconds because those are what an operator reasons about; the
host monitor samples at 1 Hz, so seconds and samples are one-to-one. A reserve
is *not* satisfied by a sample lacking an absolute byte count — a
fraction-only sample counts as a violation rather than silently passing a check
that was explicitly requested.

Two behaviours differ deliberately. The available-memory floor is **sustained**:
memory-mapping a checkpoint far larger than RAM necessarily drives
`Memory\Available Bytes` low while llama.cpp prefetches the mapping, and those
pages are file-backed and reclaimable, so a transient dip is expected. Commit
charge is an **instantaneous** abort: it measures real commit against the
pagefile, and Windows begins failing allocations process-wide near the limit.

Note that under WDDM, GPU memory allocations consume system commit. Raising VRAM
residency raises commit charge roughly one-for-one, so a host whose pagefile is
small will abort here long before it runs out of VRAM. Enlarging the pagefile is
an operator action; this tool reads the limit and never changes it.

All three monitors run at one-second cadence and must independently provide at
least two monotonically timed samples, no gap longer than five seconds, and
coverage within five seconds of both capture boundaries. A clean early exit,
device loss, nonzero monitor exit, parse failure, truncation, zero/one sample,
missing boundary, or gap invalidates the candidate and aborts an in-flight
benchmark.

A live monotonic watchdog also requires the first valid query, dmon, and host
sample within five seconds and every next valid sample within five seconds.
Each expected GPU has separate identity-bound query and dmon deadlines, so
one silent GPU aborts even while the other GPU and aggregate streams remain
active. An abort cancels pre/post-roll waits and enters service-tree cleanup
immediately.

The query stream binds each sample to the exact ordered local
`backend_device` -> GPU index -> GPU UUID mapping. Missing, extra, duplicate,
wrong-index, or mapping-drift identities are rejected, and every expected GPU
must independently cover the full query window. Keep real UUIDs only in the
local config; this repository contains no machine UUID values.

The host monitor uses these exact `typeperf` counters at 1 Hz:

- `\Processor(_Total)\% Processor Time`
- `\Memory\% Committed Bytes In Use`
- `\PhysicalDisk(_Total)\Disk Bytes/sec`
- `\Memory\Available Bytes`
- `\Memory\Pages Input/sec`
- `\Memory\Page Reads/sec`

Wildcard `\Process(*)` counters are intentionally excluded from the continuous
host stream because their column count changes whenever a Windows process
starts or exits. Process-tree cleanup uses separate bounded one-shot snapshots;
the live safety stream keeps only stable-cardinality host counters.

The production command explicitly sets `-sc 86400` at the one-second interval.
This caps capture at 24 hours; any monitor exit still invalidates the
candidate. On this host, native `typeperf` can omit only the first
`Processor(_Total)` header while retaining its sample value. The parser accepts
only that exact verified omission when the remaining five names match the
pinned order; every other name/value mismatch fails closed.

Committed memory at or above 95%, or available memory below 5% of the pinned
physical total, is a hard abort. Paging counters are recorded as evidence; no
additional paging threshold is invented.

The parsed `nvidia-smi dmon` fields are exactly `gpu,pwr,gtemp,mtemp,sm,mem,enc,
dec,jpg,ofa,mclk,pclk,pviol,tviol,fb,bar1,ccpm,sbecc,dbecc,pci,rxpci,txpci`.
Every data row's `gpu` index is bound to the same exact backend-index-UUID
mapping as the query stream. Unknown indices, duplicate indices in one
timestamped dmon sample, missing GPUs, mapping drift, or incomplete
per-expected-GPU dmon coverage invalidate the candidate. Any nonzero `pci`,
`sbecc`, or `dbecc` sample is a hard abort. A `pviol` sample is recorded but is
not, by itself, a safety abort. GPU temperature at or above the configured
ceiling for five consecutive query samples is a hard abort.

Timeout and cancellation terminate only the spawned benchmark PID/tree. On
Windows, the runner requires inherited `SystemRoot` to equal the pinned literal
`C:\Windows`, then verifies the exact byte length, SHA-256, ordinary-file
identity, and recorded valid Microsoft catalog-signature evidence for
`System32\typeperf.exe` and `taskkill.exe`. It invokes only those absolute paths
with `shell:false`. Before any root kill it snapshots PID, parent PID, and
elapsed time, derives the exact descendant closure, then invokes taskkill with
the exact PID and `/T /F`; it never uses a process name or system-wide kill.
Every observed descendant remains in the verification set, including a
descendant first observed after taskkill. Bounded rescans must prove a stable
empty tree. A taskkill spawn error, timeout, nonzero exit, query ambiguity,
kill ambiguity, late descendant, or verification ambiguity is a fatal
`TASKKILL_TREE_TERMINATION_FAILED` NO-GO. On taskkill failure, captured
descendants are force-terminated deepest-first, then the root, and verified
gone before the fatal result is surfaced. The same path is used for benchmark,
telemetry, and server service processes. This is verified cleanup, not Windows
Job Object containment.

The live server/SSE/tokenizer/slot/tool-loop primitives are implemented and
unit-tested. The final campaign driver requires the local config to set
`live.moe_cache_mode` to the literal `on` or `off`. It also requires an
absolute `live.arm_comparison_manifest` plus its SHA-256. That manifest binds
the campaign record, every completed short-sweep state and config, the declared
finalist, and exactly two arms whose candidate/runtime records are byte-for-byte
equivalent after removing only `moe_cache_mode`. The manifest's runtime digest
must equal the fresh preflight identity. A claim that the arms are comparable
is therefore rejected unless the recorded evidence proves it. The live command
then requires explicit confirmation:

```powershell
.\Invoke-OrnithBenchmark.ps1 RunFinalCampaign -Config .\config\ornith-local.json
```

It runs six hash-recorded units in order: the exact 8K/1024 x5 and 16K/1024 x3
final isolated benchmarks, three separate process-cold server starts, one warm
17-case quality run, and the 24-minute sustained mixed run with a 30-minute
absolute cap. Each unit receives independent 60-second telemetry pre-roll and
30-second post-roll. Completed units resume only after every recorded artifact
hash verifies and the exact per-unit artifact policy still matches. Resume
identity binds the canonical full config, runtime/model/suite identity, all
harness source files, the arm manifest, and those artifact policies. Hidden,
missing, reparse, changed, or oversized artifacts fail closed. A nonempty
partial unit is rejected and never overwritten; the driver has no retry loop.
`rounds.csv` receives every actual model round. Unit summaries are derived
artifacts bound to all unit raw files; `result.json` binds the complete candidate
artifact closure. After sustained completion it applies the protocol's
minimum-sample,
minimum-median, quality, and speed-band decision algorithm. The campaign-level
`decision.json` remains a cross-candidate reduction and is produced only after
all finalist candidates complete.

After every declared finalist has a complete, hash-verified `result.json`, write
the one immutable campaign reduction by naming the exact expected set:

```powershell
node .\bin\ornith-benchmark.mjs write-decision --config .\config\ornith-local.json --candidate <FIRST_ID> --candidate <SECOND_ID>
```

The command fails if any declared result or any artifact bound by that result is
missing or changed. It never starts the model, a GPU process, or telemetry.

Every bench and server process gets an explicit
`GGML_CUDA_MOE_CACHE=0` or `GGML_CUDA_MOE_CACHE=1`. The parent environment is
never allowed to choose the mode. This is required because the cache source
defaults on when the variable is absent.

Telemetry marks `request_in_flight` only around the exact `llama-bench` process
or SSE model request, not server load, thermal settling, tools, or pre/post-roll.
Before those windows an `nvidia-smi` compute-app query must show the exact
spawned benchmark/server PID on every declared GPU and no competing PID. Active
PCIe generation/width and dmon RX/TX evidence must be finite; any `tviol` is a
failure while `pviol` remains recorded evidence. Free result-volume space is
checked before the unit and around every request. Sustained scoring and coverage
use the same named set of complete, positive, >=64-token timing samples, and one
absolute deadline is propagated through every SSE request and tool action.

Quality passes require model-performed evidence: a successful patch, a
model-requested passing deterministic test, a later nonempty final diff, and
then the independent hidden oracle. The hidden post-run oracle cannot substitute
for skipped model work. Ambiguous and stop/ask cases require case-specific
clarification/refusal text and zero tool calls.

## Safety boundary

- Model-generated paths are contained beneath a per-case workspace.
- Reparse/symlink escapes and protected `.git`, `.ornith-control`, and
  `.ornith-hidden` paths are rejected.
- Test commands are one exact pinned `@node` executable-plus-argv shape,
  launched with `shell:false`; alternate executables and argv are forbidden.
- The trusted parent reads the focused test and hidden oracle separately and
  passes each source over bounded stdin to a different Node 24 permission
  process with a different cwd. Neither process receives a filesystem grant
  for either source, the case root, or the other process's hidden data. Child
  processes, workers, native addons, WASI, and all filesystem writes are
  denied.
- The child environment drops credentials and package-manager configuration.
- `NODE_OPTIONS` and `NODE_PATH` are explicitly cleared.
- A locked preload guard blocks fetch, WebSocket, HTTP(S), HTTP/2, TCP, TLS,
  UDP, DNS, inspector listeners, child-process APIs, and public native-binding
  bypasses; ESM builtin exports are synchronized after patching.
- There is no delete tool, package-install tool, general shell tool, or
  process-wide kill operation.
- Raw artifacts use create-new semantics. Derived JSON records every raw-input
  SHA-256.

Run deterministic tests with:

```powershell
node --test .\tests\*.test.mjs
```
