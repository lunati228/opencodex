import { arch, hostname, platform } from "node:os";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const CAMPAIGN_INVENTORY_NAMES = Object.freeze([
  "versions.txt",
  "hashes.sha256",
  "devices.txt",
  "gpu-topology.txt",
  "host.txt",
]);

export function campaignInventoryPaths(resultRoot) {
  return CAMPAIGN_INVENTORY_NAMES.map((name) =>
    path.join(resultRoot, "inventory", name));
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function expectedInventory(config, preflight, suite) {
  const digests = [
    ["llama_bench", preflight.paths?.llama_bench?.sha256],
    ["llama_server", preflight.paths?.llama_server?.sha256],
    ["model", preflight.hash_evidence?.model_sha256],
    ["runtime_manifest", preflight.runtime_evidence?.manifest_sha256],
    ["runtime_content_set", preflight.runtime_evidence?.content_set_sha256],
    ["quality_suite", suite.suite_sha256],
  ];
  if (digests.some(([, digest]) => !/^[a-f0-9]{64}$/.test(digest ?? ""))) {
    throw new Error("CAMPAIGN_INVENTORY_DIGEST_MISSING");
  }
  return new Map([
    ["versions.txt", jsonText({
      schema_version: "ornith-inventory-1",
      llama_tag: config.candidate.llama_tag,
      llama_commit: config.candidate.llama_commit,
      node: process.version,
      node_major: Number(process.versions.node.split(".")[0]),
    })],
    ["hashes.sha256", `${digests
      .map(([role, digest]) => `${digest}  ${role}`)
      .join("\n")}\n`],
    ["devices.txt", jsonText({
      schema_version: "ornith-inventory-1",
      devices: config.candidate.backend_devices.map(
        (backend_device, index) => ({
          backend_device,
          gpu_uuid: config.candidate.device_order[index],
        }),
      ),
    })],
    ["gpu-topology.txt", jsonText({
      schema_version: "ornith-inventory-1",
      backend_device_order: config.candidate.backend_devices,
      gpu_uuid_order: config.candidate.device_order,
      split_mode: config.candidate.split_mode,
    })],
    ["host.txt", jsonText({
      schema_version: "ornith-inventory-1",
      host_id: hostname(),
      platform: platform(),
      architecture: arch(),
      expected_physical_memory_bytes:
        config.live.expected_physical_memory_bytes,
    })],
  ]);
}

export async function ensureCampaignInventory({
  resultRoot,
  config,
  preflight,
  suite,
  allowCreate = false,
}) {
  const inventoryRoot = path.join(resultRoot, "inventory");
  const expected = expectedInventory(config, preflight, suite);
  const paths = campaignInventoryPaths(resultRoot);
  const existence = await Promise.all(
    paths.map(async (filePath) => {
      try {
        const metadata = await lstat(filePath);
        return metadata.isFile() && !metadata.isSymbolicLink();
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }),
  );
  if (existence.every((value) => !value) && allowCreate) {
    await mkdir(inventoryRoot, { recursive: true });
    await Promise.all(
      [...expected].map(([name, content]) =>
        writeFile(path.join(inventoryRoot, name), content, { flag: "wx" })),
    );
  } else if (existence.some((value) => !value)) {
    throw new Error("CAMPAIGN_INVENTORY_SET_INCOMPLETE");
  }
  for (const [name, content] of expected) {
    const filePath = path.join(inventoryRoot, name);
    const metadata = await lstat(filePath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > 4 * 1024 * 1024 ||
      (await readFile(filePath, "utf8")) !== content
    ) {
      throw new Error(`CAMPAIGN_INVENTORY_MISMATCH: ${name}`);
    }
  }
  return paths;
}
