#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCacheRuntimeManifest } from "../src/cache-runtime-manifest.mjs";
import { sha256Bytes } from "../src/hash.mjs";

const ARGUMENTS = Object.freeze([
  "runtime-root",
  "build-record",
  "build-record-sha256",
  "toolchain-evidence",
  "toolchain-evidence-sha256",
  "output",
]);

function usage() {
  return [
    "USAGE: create-cache-runtime-manifest",
    "--runtime-root <absolute>",
    "--build-record <absolute> --build-record-sha256 <sha256>",
    "--toolchain-evidence <absolute> --toolchain-evidence-sha256 <sha256>",
    "--output <absolute>",
  ].join(" ");
}

function parseArguments(argv) {
  if (argv.length !== ARGUMENTS.length * 2) throw new Error(usage());
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !name?.startsWith("--") ||
      !ARGUMENTS.includes(name.slice(2)) ||
      typeof value !== "string" ||
      Object.hasOwn(values, name.slice(2))
    ) {
      throw new Error(usage());
    }
    values[name.slice(2)] = value;
  }
  for (const name of [
    "runtime-root",
    "build-record",
    "toolchain-evidence",
    "output",
  ]) {
    if (!path.isAbsolute(values[name])) {
      throw new Error(`ABSOLUTE_ARGUMENT_REQUIRED: ${name}`);
    }
  }
  for (const name of ["build-record-sha256", "toolchain-evidence-sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(values[name])) {
      throw new Error(`SHA256_ARGUMENT_INVALID: ${name}`);
    }
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
  return values;
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const manifest = await buildCacheRuntimeManifest({
    runtimeRoot: values["runtime-root"],
    buildRecord: {
      path: values["build-record"],
      sha256: values["build-record-sha256"],
    },
    toolchainEvidence: {
      path: values["toolchain-evidence"],
      sha256: values["toolchain-evidence-sha256"],
    },
  });
  const outputBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, outputBytes, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    output: values.output,
    manifest_sha256: sha256Bytes(outputBytes),
    provenance_kind: manifest.provenance.kind,
    file_count: manifest.file_set.file_count,
    total_bytes: manifest.file_set.total_bytes,
    content_set_sha256: manifest.file_set.content_set_sha256,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
