// 「必ず行く場所」に付ける、出発地からの距離の目安のテスト。

import assert from "node:assert/strict";
import test from "node:test";

import { reachOf } from "../js/reach.js";

const TOKYO = { name: "東京駅", lat: 35.6812, lng: 139.7671 };

test("すぐ近くは徒歩圏内と言う", () => {
  const r = reachOf(TOKYO, { lat: 35.6852, lng: 139.7528 }); // 皇居
  assert.equal(r.text, "東京駅から徒歩圏内");
  assert.equal(r.far, false);
});

test("近場は手段と10分単位の所要時間を出す", () => {
  const r = reachOf(TOKYO, { lat: 35.3192, lng: 139.5467 }); // 鎌倉
  assert.match(r.text, /^東京駅から.+で約(\d+時間)?(\d+0分)?（目安）$/);
  assert.equal(r.far, false);
});

test("日帰りに向かない遠さは far を立てる", () => {
  const r = reachOf(TOKYO, { lat: 44.0, lng: 145.0 }); // 知床
  assert.equal(r.far, true);
  assert.match(r.text, /空路/);
});

test("座標が無ければ出さない", () => {
  assert.equal(reachOf(null, { lat: 35, lng: 139 }), null);
  assert.equal(reachOf(TOKYO, { name: "どこか" }), null);
});
