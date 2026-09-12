import { expect, test } from "bun:test";
import { scanText } from "../scripts/privacy-scan";

test("the documented Bun container user is allowed without allowing workstation identities", () => {
  const containerPath = "/home/bun/app";
  expect(scanText("docs-site/src/content/docs/guides/remote-hub.md", containerPath)).toEqual([]);
  expect(scanText("devlog/_plan/example/plan.md", containerPath)).toEqual([]);
  for (const file of ["compose.yaml", "scripts/ci/docker-smoke.ts", "structure/02_config-and-codex-home.md"]) {
    expect(scanText(file, containerPath)).toEqual([]);
    expect(scanText(file, "/home/private-person/app").some(row => row.kind === "home-path")).toBe(true);
  }
  expect(scanText("src/example.ts", containerPath).some(row => row.kind === "home-path")).toBe(true);
  expect(scanText("docs-site/src/content/docs/guides/remote-hub.md", "/home/private-person/app")
    .some(row => row.kind === "home-path")).toBe(true);
});

test("the generated ADC key fixture allowance follows its domain location only", () => {
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  expect(scanText("tests/adapters/google/gcp-adc.test.ts", header)).toEqual([]);
  expect(scanText("tests/gcp-adc.test.ts", header).some(row => row.kind === "private-key-header")).toBe(true);
  expect(scanText("src/example.ts", header).some(row => row.kind === "private-key-header")).toBe(true);
});
