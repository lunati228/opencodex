import { expect, test } from "bun:test";
import { accountQuotaFromReport } from "../src/provider-workspace/report";

test("quota reports fail closed instead of inventing a fresh timestamp", () => {
  expect(accountQuotaFromReport({
    source: "test:quota",
    quota: { weeklyPercent: 25 },
  })).toBeNull();
});

test("quota reports preserve the provider timestamp exactly", () => {
  const updatedAt = 1_785_132_000_000;
  expect(accountQuotaFromReport({
    source: "test:quota",
    updatedAt,
    quota: { weeklyPercent: 25 },
  })).toEqual({
    weeklyPercent: 25,
    updatedAt,
  });
});
