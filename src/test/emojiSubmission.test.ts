import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { expect, test } from "vitest";

import {
  compressEmoji,
  MAX_EMOJI_BYTES,
  MAX_UPLOAD_BYTES,
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

test("validateEmojiSubmission – allows files it can compress", () => {
  expect(
    validateEmojiSubmission({ contentType: "image/gif", size: MAX_EMOJI_BYTES + 1 }, "big"),
  ).toBeNull();
});

test("validateEmojiSubmission – rejects uploads too large to compress", () => {
  expect(
    validateEmojiSubmission({ contentType: "image/png", size: MAX_UPLOAD_BYTES + 1 }, "huge"),
  ).toMatch(/8 MB/);
});

/** Random noise, which compresses badly, so the file starts well over 256 KB. */
function noise(width: number, height: number) {
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  });
}

test("compressEmoji – leaves images under the limit untouched", async () => {
  const small = await noise(16, 16).png().toBuffer();
  expect(await compressEmoji(small, "image/png")).toBe(small);
});

test.each([
  ["image/png", "png", (img: sharp.Sharp) => img.png()],
  ["image/jpeg", "jpeg", (img: sharp.Sharp) => img.jpeg({ quality: 100 })],
  ["image/webp", "webp", (img: sharp.Sharp) => img.webp({ lossless: true })],
  ["image/gif", "gif", (img: sharp.Sharp) => img.gif()],
])("compressEmoji – shrinks a large %s under the limit", async (type, format, encode) => {
  const large = await encode(noise(1024, 1024)).toBuffer();
  expect(large.length).toBeGreaterThan(MAX_EMOJI_BYTES);

  const compressed = await compressEmoji(large, type);
  expect(compressed).not.toBeNull();
  expect(compressed!.length).toBeLessThanOrEqual(MAX_EMOJI_BYTES);
  expect((await sharp(compressed!).metadata()).format).toBe(format);
});
