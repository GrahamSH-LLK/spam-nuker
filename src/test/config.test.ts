import { expect, test } from "vitest";

import { getDefaultConfig, mergeGuildConfig } from "../config.js";

test("mergeGuildConfig – returns defaults when nothing is stored", () => {
  const defaults = getDefaultConfig();
  expect(mergeGuildConfig(defaults, {})).toEqual(defaults);
});

test("mergeGuildConfig – applies stored numeric overrides", () => {
  const defaults = getDefaultConfig();
  const merged = mergeGuildConfig(defaults, {
    timeoutDuration: "120",
    messageThreshold: "5",
  });

  expect(merged.timeoutDuration).toBe(120);
  expect(merged.messageThreshold).toBe(5);
  expect(merged.imageThreshold).toBe(defaults.imageThreshold);
});

test("mergeGuildConfig – ignores non-numeric stored values", () => {
  const defaults = getDefaultConfig();
  const merged = mergeGuildConfig(defaults, { timeoutDuration: "banana" });

  expect(merged.timeoutDuration).toBe(defaults.timeoutDuration);
});

test("mergeGuildConfig – stored log channel overrides the default", () => {
  const merged = mergeGuildConfig(getDefaultConfig(), {
    logChannelId: "123456789",
  });

  expect(merged.logChannelId).toBe("123456789");
});

test("mergeGuildConfig – empty log channel disables alerts", () => {
  const defaults = { ...getDefaultConfig(), logChannelId: "999" };
  const merged = mergeGuildConfig(defaults, { logChannelId: "" });

  expect(merged.logChannelId).toBeNull();
});
