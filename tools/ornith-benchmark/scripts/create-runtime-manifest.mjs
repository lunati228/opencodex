#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Bytes } from "../src/hash.mjs";
import { buildRuntimeManifest } from "../src/runtime-manifest.mjs";

const EXPECTED = Object.freeze({
  project: "ggml-org/llama.cpp",
  release_tag: "b10099",
  commit: "1a064ab0921238c1daa397d6f4a900ef33884de2",
  install_manifest_sha256:
    "690756fa1d6a16b1390c8d74a22266849011a1ca3f26f767afde0635a3923b96",
  file_count: 55,
  total_bytes: 700_841_136,
  content_set_sha256:
    "c0280f0cb8e554d383d64d689f373f5d7f93c2ce5bf520a9c0c75b64f7ebd6b1",
  archives: [
    {
      name: "llama-b10099-bin-win-cuda-13.3-x64.zip",
      bytes: 146_346_975,
      sha256:
        "5c4dc4bac64f56ada6831982049d880836d1589c5c8e991bfcf7fdd4e07ef85a",
    },
    {
      name: "cudart-llama-bin-win-cuda-13.3-x64.zip",
      bytes: 390_970_417,
      sha256:
        "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e",
    },
  ],
});

const LOAD_SURFACE = new Set([
  "cublas64_13.dll",
  "cublasLt64_13.dll",
  "cudart64_13.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-cascadelake.dll",
  "ggml-cpu-cooperlake.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-ivybridge.dll",
  "ggml-cpu-piledriver.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-sapphirerapids.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll",
  "ggml-cpu-zen4.dll",
  "ggml-cuda.dll",
  "ggml-rpc.dll",
  "libomp140.x86_64.dll",
  "llama.dll",
  "llama-bench.exe",
  "llama-bench-impl.dll",
  "llama-common.dll",
  "llama-server.exe",
  "llama-server-impl.dll",
  "mtmd.dll",
]);

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--runtime-root", "--install-manifest", "--output"].includes(name) ||
      typeof value !== "string"
    ) {
      throw new Error(
        "USAGE: create-runtime-manifest --runtime-root <absolute> --install-manifest <absolute> --output <absolute>",
      );
    }
    values[name.slice(2)] = value;
  }
  for (const name of ["runtime-root", "install-manifest", "output"]) {
    if (!path.isAbsolute(values[name] ?? "")) {
      throw new Error(`ABSOLUTE_ARGUMENT_REQUIRED: ${name}`);
    }
  }
  return values;
}

function rolesForFile(name) {
  const roles = [];
  if (name === "llama-bench.exe") roles.push("bench-entrypoint", "launcher");
  else if (name === "llama-server.exe") {
    roles.push("server-entrypoint", "launcher");
  } else if (
    name === "llama-bench-impl.dll" ||
    name === "llama-server-impl.dll"
  ) {
    roles.push("entrypoint-implementation");
  } else if (/^ggml-cpu-.*\.dll$/.test(name)) {
    roles.push("ggml-cpu-backend-plugin");
  } else if (name.endsWith(".dll")) {
    roles.push("runtime-dependency");
  } else if (name.endsWith("-impl.dll")) {
    roles.push("bundled-tool-implementation");
  } else if (name.endsWith(".exe")) {
    roles.push("bundled-tool-executable");
  }
  if (LOAD_SURFACE.has(name)) roles.push("load-surface");
  return [...new Set(roles)];
}

function sameArchive(left, right) {
  return (
    left.name === right.name &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.url ===
      `https://github.com/ggml-org/llama.cpp/releases/download/b10099/${left.name}`
  );
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const installBytes = await readFile(values["install-manifest"]);
  const installSha256 = sha256Bytes(installBytes);
  if (installSha256 !== EXPECTED.install_manifest_sha256) {
    throw new Error("INSTALL_MANIFEST_SHA256_MISMATCH");
  }
  const install = JSON.parse(installBytes);
  if (
    install.runtime?.project !== EXPECTED.project ||
    install.runtime?.release !== EXPECTED.release_tag ||
    install.runtime?.commit !== EXPECTED.commit ||
    !Array.isArray(install.archives) ||
    install.archives.length !== EXPECTED.archives.length ||
    install.archives.some(
      (archive, index) => !sameArchive(archive, EXPECTED.archives[index]),
    )
  ) {
    throw new Error("INSTALL_MANIFEST_PROVENANCE_MISMATCH");
  }
  const manifest = await buildRuntimeManifest({
    runtimeRoot: values["runtime-root"],
    identity: {
      project: EXPECTED.project,
      release_tag: EXPECTED.release_tag,
      commit: EXPECTED.commit,
      platform: "windows-x86_64",
      cuda_bundle: "13.3",
    },
    provenance: {
      install_manifest_path: values["install-manifest"],
      install_manifest_sha256: installSha256,
      archives: install.archives.map(({ name, url, bytes, sha256 }) => ({
        name,
        url,
        bytes,
        sha256,
      })),
    },
    rolesForFile,
  });
  if (
    manifest.file_set.file_count !== EXPECTED.file_count ||
    manifest.file_set.total_bytes !== EXPECTED.total_bytes ||
    manifest.file_set.content_set_sha256 !== EXPECTED.content_set_sha256
  ) {
    throw new Error(
      `AUDITED_RUNTIME_CLOSURE_MISMATCH: files=${manifest.file_set.file_count} bytes=${manifest.file_set.total_bytes} content_set_sha256=${manifest.file_set.content_set_sha256}`,
    );
  }
  const relative = path.relative(
    path.resolve(values["runtime-root"]),
    path.resolve(values.output),
  );
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    throw new Error("OUTPUT_MUST_BE_OUTSIDE_RUNTIME_ROOT");
  }
  const outputBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, outputBytes, { flag: "wx" });
  process.stdout.write(
    `${JSON.stringify(
      {
        output: values.output,
        manifest_sha256: sha256Bytes(outputBytes),
        file_count: manifest.file_set.file_count,
        total_bytes: manifest.file_set.total_bytes,
        content_set_sha256: manifest.file_set.content_set_sha256,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
