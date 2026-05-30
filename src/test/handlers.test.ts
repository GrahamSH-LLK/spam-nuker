import { expect, test } from "vitest";

import {
  getImageUrls,
  hammingDistance,
  hashImageUrl,
} from "../handlers/imageSpam.js";
import { hashContent } from "../handlers/crossChannelSpam.js";

/**
 * Minimal Message-like object for testing.
 */
function makeMessage({
  attachments = [],
  embeds = [],
}: { attachments?: any[]; embeds?: any[] } = {}) {
  return {
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    embeds,
    guild: { id: "1" },
  } as any;
}

test("getImageUrls – returns attachment and embed image URLs", () => {
  const msg = makeMessage({
    attachments: [
      {
        contentType: "image/png",
        url: "https://cdn.discordapp.com/attachments/1/2/img.png",
      },
      { contentType: "video/mp4", url: "https://example.com/video.mp4" },
    ],
    embeds: [
      { image: { url: "https://example.com/image.jpg" }, thumbnail: null },
      { image: null, thumbnail: { url: "https://example.com/thumb.jpg" } },
    ],
  });

  expect(getImageUrls(msg)).toEqual([
    "https://cdn.discordapp.com/attachments/1/2/img.png",
    "https://example.com/image.jpg",
    "https://example.com/thumb.jpg",
  ]);
});

// ── hammingDistance ───────────────────────────────────────────────────────────

test("hammingDistance – counts differing bits in hex hashes", () => {
  expect(hammingDistance("0", "0")).toBe(0);
  expect(hammingDistance("0", "f")).toBe(4);
  expect(hammingDistance("a0", "af")).toBe(4);
  expect(hammingDistance("ffff", "fff0")).toBe(4);
});

test("hashImageUrl – hashes decoded image pixels", async () => {
  const hash = await hashImageUrl(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  );
  if (!hash) throw new Error("hashImageUrl returned null");
  expect(hash).toMatch(/^[0-9a-f]{16}$/);
});

// ── hashContent ────────────────────────────────────────────────────────────────

test("hashContent – returns a 16-char hex string", () => {
  const h = hashContent("hello world");
  expect(h).toMatch(/^[0-9a-f]{16}$/);
});

test("hashContent – same input produces same hash", () => {
  expect(hashContent("duplicate message")).toBe(
    hashContent("duplicate message"),
  );
});

test("hashContent – different input produces different hash", () => {
  expect(hashContent("message A")).not.toBe(hashContent("message B"));
});
