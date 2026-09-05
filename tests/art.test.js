// カードの「絵」を作るテスト。
//
// 写真が最優先ですが、収録データに写真はありません。何も無いカードは
// ただの文字の塊になるので、場所ごとに決まった絵を作ります。
//
// 大事なのは **同じ場所はいつも同じ絵になる** ことです。開くたびに
// 色が変わると、カードが別の場所に見えます。ランダムは使いません。

import assert from "node:assert/strict";
import test from "node:test";

import { artFor, moodArt } from "../js/art.js";

const spot = (over = {}) => ({ id: "s1", name: "松山城", category: "城", ...over });

test("同じ場所は、いつも同じ絵になる", () => {
  const a = artFor(spot());
  const b = artFor(spot());
  assert.deepEqual(a, b);
});

test("違う場所は、違う絵になる", () => {
  const a = artFor(spot({ id: "s1", name: "松山城" }));
  const b = artFor(spot({ id: "s2", name: "道後温泉本館", category: "温泉" }));
  assert.notEqual(a.css, b.css);
});

test("分類ごとに、その場所らしい色味になる", () => {
  // 海は青緑、温泉は橙、山は緑。色相の帯で確かめます。
  const hueOf = (s) => artFor(s).hue;
  const sea = hueOf(spot({ id: "a", category: "海岸" }));
  const onsen = hueOf(spot({ id: "b", category: "温泉" }));
  const mountain = hueOf(spot({ id: "c", category: "山" }));
  assert.ok(sea >= 150 && sea <= 230, `海が ${sea}`);
  assert.ok(onsen >= 0 && onsen <= 45, `温泉が ${onsen}`);
  assert.ok(mountain >= 70 && mountain <= 160, `山が ${mountain}`);
});

test("CSS としてそのまま使える文字列を返す", () => {
  const a = artFor(spot());
  assert.match(a.css, /gradient/);
  assert.ok(!a.css.includes("undefined"));
  assert.ok(!a.css.includes("NaN"));
});

test("絵に添える記号は、分類から決まる", () => {
  assert.equal(artFor(spot({ category: "温泉" })).icon, "♨");
  assert.equal(artFor(spot({ category: "城" })).icon, "🏯");
  // 知らない分類でも、必ず何か返します
  assert.ok(artFor(spot({ category: "謎の分類" })).icon);
});

test("名前も分類も無くても壊れない", () => {
  for (const bad of [null, undefined, {}, { name: "" }]) {
    const a = artFor(bad);
    assert.match(a.css, /gradient/);
  }
});

test("雰囲気チップにも、それらしい絵がある", () => {
  const a = moodArt("温泉でゆっくり");
  assert.match(a.css, /gradient/);
  assert.equal(moodArt("温泉でゆっくり").css, a.css, "毎回変わっています");
});
