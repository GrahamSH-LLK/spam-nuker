import { expect, test } from "vitest";

import {
  MAX_EMOJI_BYTES,
  validateEmojiSubmission,
} from "../handlers/emojiSubmission.js";

const png = { contentType: "image/png", size: 1024 };

test("validateEmojiSubmission – accepts a small PNG with a valid name", () => {
  expect(validateEmojiSubmission(png, "party_cat")).toBeNull();
});

test("validateEmojiSubmission – rejects invalid names", () => {
  expect(validateEmojiSubmission(png, "party cat")).toMatch(/names/);
  expect(validateEmojiSubmission(png, "x")).toMatch(/names/);
});

test("validateEmojiSubmission – rejects non-image attachments", () => {
  expect(
    validateEmojiSubmission({ contentType: "video/mp4", size: 1024 }, "clip"),
  ).toMatch(/PNG/);
  expect(validateEmojiSubmission({ contentType: null, size: 1024 }, "clip")).toMatch(/PNG/);
});

test("validateEmojiSubmission – rejects files over the emoji size limit", () => {
  expect(
    validateEmojiSubmission({ contentType: "image/gif", size: MAX_EMOJI_BYTES + 1 }, "big"),
  ).toMatch(/256 KB/);
});
