// 座標が引けなかった観光地の名前に、OpenStreetMap から座標を付ける道具。
//
// 配布ファイルは数GBあり、この環境からは落とせていません（接続が切れます）。
// だから**実物のデータでは、まだ動かしていません。** ここでは、小さな作り物の
// データ（tests/fixtures/osm-mini.osm）に、これまでの事故に沿った罠を仕込んで、
// 決まりが働くことを確かめます。
//
//   ① 名前が同じ別の県の場所を採らない（新田神社・八幡宮はどの県にもある）
//   ② 同じ県に離れた同名が2か所あるときは、決めない
//   ③ 店・宿・ただの建物を、名前が一致しても採らない
//   ④ 座標を作らない（OSM にあるものだけ）
//   ⑤ ODbL の表示（© OpenStreetMap contributors）を出典に入れる
//
// Python と osmium（pip install osmium）があるときだけ、実際に動かします。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const tool = read("tools/import_osm_tourlist.py");
const fetcher = read("tools/fetch_osm_extracts.py");

const py = spawnSync("python3", ["-c", "import osmium"], { encoding: "utf8" });
const skip = py.error || py.status !== 0
  ? "python3 か osmium（pip install osmium）がありません" : false;

const CODE = `
import sys, json
sys.path.insert(0, "tools")
import import_osm_tourlist as T
from import_tourism_list import PrefectureLocator
loc = PrefectureLocator(json.load(open("kb/regions.json"))["regions"])
unplaced = [
    ["北海道", "試験神社"], ["大阪府", "八幡試験社"], ["北海道", "八幡試験社"],
    ["京都府", "重複試験寺"], ["北海道", "店名試験"], ["北海道", "宿名試験"],
    ["北海道", "重なり試験公園"], ["北海道", "面試験公園"], ["北海道", "灯台試験"],
    ["北海道", "滝試験"], ["北海道", "城試験"], ["北海道", "ただの建物試験"],
    ["北海道", "通称試験"], ["北海道", "存在しない試験"], ["東京都", "試験神社"],
    ["北海道", "【閉店】試験神社"], ["北海道", "一覧に無い神社を探す試験"],
]
wanted = set()
for pref, raw in unplaced:
    nm = T.clean_name(raw)
    if nm: wanted.update(T.n(v) for v in T.variants(nm))
found = T.scan("tests/fixtures/osm-mini.osm", wanted)
hits, why = T.match(unplaced, found, loc)
print(json.dumps({
    "hits": [[p, r, c["name"], c["category"], c["osm"], round(c["lat"], 4), round(c["lng"], 4)]
             for p, r, c in hits],
    "why": dict(why), "found": sorted(found)}, ensure_ascii=False))
`;

function run() {
  const r = spawnSync("python3", ["-c", CODE], { cwd: root.pathname,
    encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const byRaw = (out, pref, raw) =>
  out.hits.find((h) => h[0] === pref && h[1] === raw);

test("県が合うものだけを採る（同じ名前が別の県にもある）", { skip }, () => {
  const out = run();
  // 大阪府の一覧の「八幡試験社」は大阪のもの、北海道の一覧は北海道のもの。
  const osaka = byRaw(out, "大阪府", "八幡試験社");
  const hokkaido = byRaw(out, "北海道", "八幡試験社");
  assert.equal(osaka[4], "node/2");
  assert.equal(hokkaido[4], "node/3");
  // 名前は北海道の神社と同じでも、一覧が東京都なら、採らない。
  assert.equal(byRaw(out, "東京都", "試験神社"), undefined,
    "県が違う場所を、一覧の県のものとして採っています");
});

test("同じ県に離れた同名が2か所あるときは、決めない", { skip }, () => {
  const out = run();
  assert.equal(byRaw(out, "京都府", "重複試験寺"), undefined);
  assert.ok(out.why["同じ県に同名が複数（決められない）"] >= 1);
});

test("800m 以内の同名は、同じ場所として1つに数える", { skip }, () => {
  const out = run();
  const h = byRaw(out, "北海道", "重なり試験公園");
  assert.ok(h, "点が2つあるだけで、決められないと数えています");
  // 同じ種類なら番号の若いほう（走らせるたびに変わらない）。
  assert.equal(h[4], "node/8");
});

test("店・宿・ただの建物は、名前が一致しても採らない", { skip }, () => {
  const out = run();
  for (const raw of ["店名試験", "宿名試験", "ただの建物試験"]) {
    assert.equal(byRaw(out, "北海道", raw), undefined,
      `${raw} を行き先として採っています`);
  }
});

test("分類は、名前ではなくタグから決める", { skip }, () => {
  const out = run();
  assert.equal(byRaw(out, "北海道", "試験神社")[3], "神社");
  assert.equal(byRaw(out, "北海道", "灯台試験")[3], "灯台");
  assert.equal(byRaw(out, "北海道", "滝試験")[3], "滝");
  assert.equal(byRaw(out, "北海道", "城試験")[3], "城");
  // 「試験神社」の名前は神社ですが、公園のタグなら公園にする。
  assert.equal(byRaw(out, "北海道", "面試験公園")[3], "公園");
});

test("閉じた面の重心は、始点を2度数えない", { skip }, () => {
  const out = run();
  const h = byRaw(out, "北海道", "面試験公園");
  // 四隅（43.06/43.07 と 141.35/141.36）の平均は 43.065 / 141.355。
  // 始点を2度数えると 43.0640 のほうへ偏る。
  assert.equal(h[5], 43.065);
  assert.equal(h[6], 141.355);
});

test("alt_name（通称）でも当たり、表示は正式な名前", { skip }, () => {
  const out = run();
  const h = byRaw(out, "北海道", "通称試験");
  assert.ok(h);
  assert.equal(h[2], "正式名試験");
});

test("閉店の札は、OSM に同名があっても外す", { skip }, () => {
  const out = run();
  assert.equal(byRaw(out, "北海道", "【閉店】試験神社"), undefined);
});

test("一覧に無い名前は拾わない（全部を持たない）", { skip }, () => {
  const out = run();
  assert.ok(!out.found.includes("一覧に無い神社"),
    "一覧に無い名前まで、覚えています");
});

test("ODbL の表示と、出どころの印を持つ", () => {
  // 「© OpenStreetMap contributors」の表示は必須。画面の下の「データ: …」に
  // そのまま出ます。
  assert.match(tool, /© OpenStreetMap contributors \(ODbL\)/);
  assert.match(tool, /openstreetmap\.org\/copyright/);
  assert.match(tool, /register\(shards, regions_doc, \[OSM_SOURCE, PREF_SOURCE\]\)/);
  // まとめて外せるように、印と元の番号を1件ごとに持つ。
  assert.match(tool, /SRC = "osm-tourlist"/);
  assert.match(tool, /"osm": c\["osm"\]/);
  // 同じ条件で共有する義務があることを、書いてあること。
  assert.match(tool, /同じ条件で共有する義務/);
  assert.match(tool, /share-alike/);
});

test("ほかの取り込みと、印を分けている", () => {
  // 同じ印にすると、あちらを走らせたときにこちらのぶんが消える。
  assert.ok(!/SRC = "wikipedia/.test(tool));
  assert.match(tool, /x\.get\("src"\) != SRC/);
  assert.match(tool, /前回のぶん/);
});

test("1件ずつ聞かない（地域ごとの配布ファイルを読む）", () => {
  // 国土地理院は施設名で引けず、Nominatim は大量の問い合わせを禁じている。
  assert.match(tool, /Nominatim/);
  assert.match(tool, /osm\.pbf/);
  assert.ok(!/urlopen|requests\.get|nominatim\.openstreetmap|msearch\.gsi/.test(tool),
    "1件ずつ問い合わせようとしています");
});

test("落としきれなかったファイルを残さない", () => {
  // 半分のファイルを残すと、次に「もうある」と見なして読み、地域の半分しか
  // 照合されません。
  assert.match(fetcher, /\.part/);
  assert.match(fetcher, /os\.replace\(tmp, path\)/);
  assert.match(fetcher, /途中で切れたものを残しません/);
});

test("収録の座標を作らない（OSM にあるものだけ）", () => {
  // 一覧の名前を、それらしい場所に置く道は、ありません。
  assert.match(tool, /OSM に無い（または県が合わない）/);
  assert.ok(!/random|jitter|region\["lat"\], *region\["lng"\]/.test(tool),
    "座標を作ろうとしています");
});
