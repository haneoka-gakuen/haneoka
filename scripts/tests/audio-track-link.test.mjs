import assert from "node:assert/strict";
import { test } from "node:test";
import { audioTrackDetailPath } from "../../src/lib/audio-track-link.ts";

test("catalogue links preserve their source, return location and difficulty", () => {
  const detailPath =
    "/zh-CN/community/gbp/songs/detail/?song=1&return=%2Fzh-CN%2Fcommunity%2Fgbp%2Fsongs%2F&chartDifficulty=expert";
  assert.equal(audioTrackDetailPath({ id: "1", songKey: "gbp:intl:1", detailPath }, "ja"), detailPath);
  assert.equal(
    audioTrackDetailPath({ id: "songs:jp:123", detailPath: "/jp/en/songs/123/" }, "en"),
    "/jp/en/songs/123/",
  );
});

for (const game of ["gbp", "sekai"]) {
  for (const locale of ["en", "ja", "ko", "zh-CN", "zh-TW"]) {
    test(`saved ${game} queue opens its own song in ${locale}`, () => {
      const href = audioTrackDetailPath({ id: "1-3", songKey: `${game}:intl:1` }, locale);
      const url = new URL(href, "https://haneoka.org");
      assert.equal(url.pathname, `/${locale}/community/${game}/songs/detail/`);
      assert.equal(url.searchParams.get("song"), "1");
    });
  }
}

test("saved GBP keys without a region retain their song identity", () => {
  assert.equal(
    audioTrackDetailPath({ id: "bestdori:jp:1", songKey: "gbp:1" }, "ja"),
    "/ja/community/gbp/songs/detail/?song=1",
  );
});

test("legacy native tracks keep their existing fallback", () => {
  assert.equal(audioTrackDetailPath({ id: "123", songKey: "our-notes:intl:123" }, "en"), "/catalog/songs?song=123");
  assert.equal(audioTrackDetailPath({ id: "a&b" }, "en"), "/catalog/songs?song=a%26b");
});
