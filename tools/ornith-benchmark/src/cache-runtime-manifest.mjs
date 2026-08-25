import path from "node:path";

import { sha256File } from "./hash.mjs";
import { buildRuntimeManifest } from "./runtime-manifest.mjs";

export const CACHE_RUNTIME_IDENTITY = Object.freeze({
  project: "ggml-org/llama.cpp",
  release_tag: "b10099",
  // CMake embedded this commit in --version when the successful build was
  // configured. Preflight must compare against the executable-reported value.
  commit: "1a064ab0921238c1daa397d6f4a900ef33884de2",
  // The later clean source snapshot preserves the exact local port. It is
  // provenance, not the already-embedded executable identity.
  local_port_commit: "3f7eadbec435e43706ea0798810cab471d982bea",
  platform: "windows-x86_64",
  cuda_bundle: "13.3",
});

export const CACHE_RUNTIME_CLOSURE = Object.freeze([
  ["cublas64_13.dll", 52_697_712, "8c6bac24474af29627ec96500025a5d410a1b7e8ffa00e1fe13b1781fc6b3ddc"],
  ["cublasLt64_13.dll", 463_655_536, "e323abd89e0f03c1db91a09d7aeb1928de08e1f86192cc713b335fefe3e368a9"],
  ["ggml-base.dll", 666_624, "cd0af4bc392a69b8290dddaa1e2fc07159d53b203f03c1da5bc99909cf1d13d7"],
  ["ggml-cpu.dll", 926_720, "e74cc6a267d937a9ac43fe586fcd869b5afc35658acee052cac1777b0aa51345"],
  ["ggml-cuda.dll", 51_043_840, "f79564da83e2efeb51e3be8a8ad3d2e56f383d4ffd4a48d12c3b1fedb9fd79b6"],
  ["ggml.dll", 68_608, "6f3089f192c94b37b4611bed64edbb08109b39cecd5dbad24da894d7487ad015"],
  ["llama-bench-impl.dll", 914_432, "69c5f199601f15eb0bdee57851085dd4d367464f5fdff713f591a7300ba562de"],
  ["llama-bench.exe", 10_240, "1282481b324d76b405ab7e954fda510c00c84f78e130818757f301168336757e"],
  ["llama-cli-impl.dll", 1_700_352, "ea9ad73f8eeacfa47d8789c8e96672bea0acd712154a3a9b7458fdf9c2995f6e"],
  ["llama-cli.exe", 10_240, "d4be186bd09761c5ee76760c3e1649a7350cd423d19e51a47a75381aaadb107d"],
  ["llama-common.dll", 9_424_384, "b802868fe0c7ae90eeee1e8bd7d9d7ef0fdb6f7b6ded51d4a52a5e559879687c"],
  ["llama-server-impl.dll", 4_093_440, "29ef7b548cf6673f746d52c7e19117ca650fcea73267fc6dfe69122b327e8951"],
  ["llama-server.exe", 10_240, "281d30c12877294b2c289b81f7b288ff21822b39e94379cfbf186783e582fe8e"],
  ["llama.dll", 2_266_624, "093ee8cdff85bee00a4be08b439ea183bc1fecaf1d0f1c8cba8f18fd68586c1a"],
  ["mtmd.dll", 983_552, "52b782a33630c05b6a42ea96e1dca82c6a76fb01a0e5b534c2e606bff0ecbaa2"],
].map(([filePath, bytes, sha256]) => Object.freeze({ path: filePath, bytes, sha256 })));

function rolesForFile(name) {
  if (name === "llama-bench.exe") return ["bench-entrypoint", "launcher"];
  if (name === "llama-server.exe") return ["server-entrypoint", "launcher"];
  if (name === "llama-cli.exe") return ["selftest-entrypoint", "launcher"];
  if (name.endsWith("-impl.dll")) return ["entrypoint-implementation"];
  return ["runtime-dependency", "load-surface"];
}

function assertExpectedClosure(manifest, expectedClosure) {
  const expected = [...expectedClosure].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (
    manifest.files.length !== expected.length ||
    manifest.files.some((file, index) =>
      file.path !== expected[index].path ||
      file.bytes !== expected[index].bytes ||
      file.sha256 !== expected[index].sha256)
  ) {
    throw new Error("CACHE_RUNTIME_EXACT_CLOSURE_MISMATCH");
  }
}

async function verifyEvidence(label, evidence) {
  if (
    !evidence ||
    typeof evidence.path !== "string" ||
    !path.isAbsolute(evidence.path) ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? "")
  ) {
    throw new Error(`SOURCE_BUILD_EVIDENCE_INVALID: ${label}`);
  }
  if ((await sha256File(evidence.path)) !== evidence.sha256) {
    throw new Error(`SOURCE_BUILD_EVIDENCE_HASH_MISMATCH: ${label}`);
  }
}

export async function buildCacheRuntimeManifest({
  runtimeRoot,
  buildRecord,
  toolchainEvidence,
  expectedClosure = CACHE_RUNTIME_CLOSURE,
  createdAt,
}) {
  await verifyEvidence("build_record", buildRecord);
  await verifyEvidence("toolchain_evidence", toolchainEvidence);
  const manifest = await buildRuntimeManifest({
    runtimeRoot,
    identity: CACHE_RUNTIME_IDENTITY,
    provenance: {
      kind: "source-build",
      base_release_tag: CACHE_RUNTIME_IDENTITY.release_tag,
      base_commit: CACHE_RUNTIME_IDENTITY.commit,
      local_port_commit: CACHE_RUNTIME_IDENTITY.local_port_commit,
      build_record: structuredClone(buildRecord),
      toolchain_evidence: structuredClone(toolchainEvidence),
    },
    rolesForFile,
    createdAt,
  });
  assertExpectedClosure(manifest, expectedClosure);
  return manifest;
}
