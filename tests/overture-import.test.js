// Overture Maps から座標を付けた観光地の、収録の中身を確かめる。
//
// 道具そのもの（tools/import_overture_places.py）は 178MB の素データが要り、
// CI では走らせません。ここでは**入れたあとの収録**を見て、決まりが守られて
// いることを確かめます。
//
//   ① 索引に登録されていて、並べ直しのあとも残っている
//   ② 出典（Overture Maps Foundation）が、画面の下に出る
//   ③ 1件ずつライセンスを持つ（CDLA / Apache / CC0 のいずれか）
//   ④ 飲食店・宿・店を入れない（閉業を見分けられないため）
//   ⑤ 座標はすべて Overture 由来で、エリアの100km以内
//   ⑥ 県が食い違うものは、一覧の県（listedIn）を残している

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const index = JSON.parse(read("kb/index.json"));
const regions = JSON.parse(read("kb/regions.json")).regions;
const byId = new Map(regions.map((r) => [r.id, r]));
const all = index.shards.flatMap((s) => JSON.parse(read(`kb/${s.file}`)).spots);
const mine = all.filter((s) => s.src === "overture-tourlist");
const tool = read("tools/import_overture_places.py");

test("Overture 由来が、並べ直しのあとも収録に残っている", () => {
  assert.ok(mine.length > 1000, `Overture 由来が ${mine.length}件しかありません`);
});

test("出典に Overture Maps Foundation が入っている", () => {
  const names = (index.sources ?? []).map((x) => x.name);
  assert.ok(names.some((n) => /Overture Maps Foundation/.test(n)));
});

test("1件ずつライセンスを持ち、共有の義務があるものを混ぜない", () => {
  for (const s of mine) {
    assert.match(s.license ?? "", /CDLA|Apache|CC0/i, `${s.name} のライセンス`);
    assert.ok(s.overture, `${s.name} に Overture の番号がありません`);
  }
});

test("飲食店・宿・店・駅を入れない", () => {
  const bad = mine.filter((s) =>
    /(レストラン|食堂|カフェ|珈琲|喫茶|居酒屋|ホテル|旅館|民宿|ペンション|直売所|ショップ|株式会社)/.test(s.name)
    || (s.name.endsWith("駅") && !s.name.includes("道の駅")));
  assert.deepEqual(bad.map((s) => s.name), []);
  // 道具の側にも、外す決まりが書いてある。
  assert.match(tool, /restaurant/);
  assert.match(tool, /hotel/);
  assert.match(tool, /js\/meals\.js/);
});

test("エリアから離れすぎたものを置かない", () => {
  for (const s of mine) {
    const r = byId.get(s.regionId);
    assert.ok(r, `${s.name} のエリアがありません`);
    const km = Math.hypot((s.lat - r.lat) * 111,
      (s.lng - r.lng) * 111 * Math.cos((r.lat * Math.PI) / 180));
    assert.ok(km <= 101, `${s.name} がエリア ${r.name} から ${km.toFixed(0)}km`);
  }
});

test("県が食い違うものは、一覧の県を残している", () => {
  assert.match(tool, /spot\["listedIn"\] = pref/);
  const withList = mine.filter((s) => s.listedIn);
  assert.ok(withList.length > 0);
  // 県境の近くでは、いちばん近いエリアが一覧の県のこともあります（県の判定は
  // エリアの近さで行うため）。ほとんどは、置き先の県が一覧と違うはずです。
  const differ = withList.filter(
    (s) => byId.get(s.regionId)?.prefecture !== s.listedIn);
  assert.ok(differ.length / withList.length > 0.9,
    `食い違いの印が付いたのに、県が合っているものが多すぎます`);
});

test("神社を教会にしない（名前の終わりを、種類より先に見る）", () => {
  assert.deepEqual(
    mine.filter((s) => /神社$/.test(s.name) && s.category === "教会")
      .map((s) => s.name), []);
});

test("座標を作らない（Overture の値をそのまま使う）", () => {
  assert.doesNotMatch(tool, /"lat":\s*region\[/);
  assert.match(tool, /"lat": lat, "lng": lng|round\(c\["lat"\], 5\)/);
});
