'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isExternalImageUrl, countExternalImages } = require('../src/handlers/imageSpam');
const { hashContent } = require('../src/handlers/crossChannelSpam');

// ── isExternalImageUrl ─────────────────────────────────────────────────────────

test('isExternalImageUrl – Discord CDN URLs are NOT external', () => {
  assert.equal(isExternalImageUrl('https://cdn.discordapp.com/attachments/123/456/img.png'), false);
  assert.equal(isExternalImageUrl('https://media.discordapp.net/attachments/foo.png'), false);
  assert.equal(isExternalImageUrl('https://discord.com/assets/logo.png'), false);
});

test('isExternalImageUrl – Discord CDN attachment from different server is external', () => {
  assert.equal(isExternalImageUrl('https://cdn.discordapp.com/attachments/123/456/img.png', '999'), true);
  assert.equal(isExternalImageUrl('https://cdn.discordapp.com/attachments/123/456/img.png', '123'), false);
});

test('isExternalImageUrl – External URLs are external', () => {
  assert.equal(isExternalImageUrl('https://i.imgur.com/abc.png'), true);
  assert.equal(isExternalImageUrl('https://example.com/photo.jpg'), true);
  assert.equal(isExternalImageUrl('https://pbs.twimg.com/media/xyz.jpg'), true);
});

test('isExternalImageUrl – Invalid/empty strings return false', () => {
  assert.equal(isExternalImageUrl('not-a-url'), false);
  assert.equal(isExternalImageUrl(''), false);
});

// ── countExternalImages ────────────────────────────────────────────────────────

/**
 * Minimal Message-like object for testing.
 */
function makeMessage({ attachments = [], embeds = [] } = {}) {
  return {
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    embeds,
    guild: { id: '1' },
  };
}

test('countExternalImages – counts image attachments from external domains', () => {
  const msg = makeMessage({
    attachments: [
      { contentType: 'image/png', url: 'https://i.imgur.com/a.png' },
      { contentType: 'image/jpeg', url: 'https://example.com/b.jpg' },
    ],
  });
  assert.equal(countExternalImages(msg), 2);
});

test('countExternalImages – ignores Discord CDN attachments', () => {
  const msg = makeMessage({
    attachments: [
      { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/img.png' },
    ],
  });
  assert.equal(countExternalImages(msg), 0);
});

test('countExternalImages – counts Discord CDN attachments from other servers', () => {
  const msg = makeMessage({
    attachments: [
      { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/999/2/img.png' },
    ],
  });
  assert.equal(countExternalImages(msg), 1);
});

test('countExternalImages – ignores non-image attachments', () => {
  const msg = makeMessage({
    attachments: [
      { contentType: 'video/mp4', url: 'https://example.com/video.mp4' },
      { contentType: 'application/pdf', url: 'https://example.com/doc.pdf' },
    ],
  });
  assert.equal(countExternalImages(msg), 0);
});

test('countExternalImages – counts external embed images and thumbnails', () => {
  const msg = makeMessage({
    embeds: [
      { image: { url: 'https://i.imgur.com/embed.png' }, thumbnail: null },
      { image: null, thumbnail: { url: 'https://pbs.twimg.com/thumb.jpg' } },
    ],
  });
  assert.equal(countExternalImages(msg), 2);
});

test('countExternalImages – ignores Discord CDN embed images', () => {
  const msg = makeMessage({
    embeds: [
      { image: { url: 'https://cdn.discordapp.com/embed.png' }, thumbnail: null },
    ],
  });
  assert.equal(countExternalImages(msg), 0);
});

test('countExternalImages – mixed attachments and embeds', () => {
  const msg = makeMessage({
    attachments: [
      { contentType: 'image/png', url: 'https://i.imgur.com/a.png' },          // external ✓
      { contentType: 'image/gif', url: 'https://cdn.discordapp.com/b.gif' },   // Discord ✗
    ],
    embeds: [
      { image: { url: 'https://example.com/c.jpg' }, thumbnail: null },        // external ✓
    ],
  });
  assert.equal(countExternalImages(msg), 2);
});

// ── hashContent ────────────────────────────────────────────────────────────────

test('hashContent – returns a 16-char hex string', () => {
  const h = hashContent('hello world');
  assert.match(h, /^[0-9a-f]{16}$/);
});

test('hashContent – same input produces same hash', () => {
  assert.equal(hashContent('duplicate message'), hashContent('duplicate message'));
});

test('hashContent – different input produces different hash', () => {
  assert.notEqual(hashContent('message A'), hashContent('message B'));
});
