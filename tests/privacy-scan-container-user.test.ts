import { expect, test } from "bun:test";
import { scanText } from "../scripts/privacy-scan";

test("the documented Bun container user is allowed without allowing workstation identities", () => {
  const containerPath = "/home/bun/app";
  expect(scanText("docs-site/src/content/docs/guides/remote-hub.md", containerPath)).toEqual([]);
  expect(scanText("devlog/_plan/example/plan.md", containerPath)).toEqual([]);
  expect(scanText("src/example.ts", containerPath).some(row => row.kind === "home-path")).toBe(true);
  expect(scanText("docs-site/src/content/docs/guides/remote-hub.md", "/home/private-person/app")
    .some(row => row.kind === "home-path")).toBe(true);
});
