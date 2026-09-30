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
    ["北海道", "みたらし試験"], ["北海道", "空白 試験公園"],
    ["北海道", "博物館史跡試験"], ["北海道", "公園記念試験"], ["北海道", "史跡だけ試験"],
    ["北海道", "城山試験公園（甲城跡）"], ["北海道", "城山試験公園（乙城跡）"],
    ["北海道", "渋谷試験公園"], ["北海道", "渋谷試験公園（あじさい）"],
    ["北海道", "別名一試験"], ["北海道", "別名二試験"],
]
wanted = set()
for pref, raw in unplaced:
    nm = T.clean_name(raw)
    if nm: wanted.update(T.n(v) for v in T.variants(nm))
found = T.scan("tests/fixtures/osm-mini.osm", wanted)
hits, why = T.match(unplaced, found, loc)
hits, shared = T.resolve_shared(hits)
print(json.dumps({
    "hits": [[p, r, c["name"], c["category"], c["osm"], round(c["lat"], 4), round(c["lng"], 4)]
             for p, r, c in hits],
    "why": dict(why), "shared": shared, "found": sorted(found)}, ensure_ascii=False))
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
  // 乱数（--show の無作為抽出に使います）は、座標には使わない。
  // 座標の値が、乱数やエリアの代表点から作られていないこと。
  assert.ok(!/jitter|random\.(uniform|gauss)|region\["lat"\], *region\["lng"\]/
    .test(tool), "座標を作ろうとしています");
  assert.ok(!/"lat": *(region|r)\[/.test(tool),
    "エリアの代表点を、スポットの座標にしています");
});

test("name が「;」でつながっているとき、一覧に当たった部分を表示する", { skip }, () => {
  const out = run();
  const h = byRaw(out, "北海道", "みたらし試験");
  assert.ok(h, "当たっていません");
  // 「福祉センター試験;みたらし試験」をそのまま出すと、画面に「;」が並ぶ。
  assert.equal(h[2], "みたらし試験");
});

test("全角スペースを半角にする", { skip }, () => {
  const out = run();
  assert.equal(byRaw(out, "北海道", "空白 試験公園")[2], "空白 試験公園");
});

test("複数のタグがあるとき、博物館・公園を先にする（史跡は受け皿）", { skip }, () => {
  const out = run();
  // tourism=museum + historic=building → 博物館（史跡ではない）
  assert.equal(byRaw(out, "北海道", "博物館史跡試験")[3], "博物館");
  // leisure=park + historic=memorial → 公園
  assert.equal(byRaw(out, "北海道", "公園記念試験")[3], "公園");
  // ほかに決め手が無い historic は、史跡。
  assert.equal(byRaw(out, "北海道", "史跡だけ試験")[3], "史跡");
});

test("別々の場所の同名が一覧に2つあるとき、どちらも足さない", { skip }, () => {
  // 栃木県の一覧には、別々の場所の「城山公園」が2つ載っています（祇園城跡・
  // 佐野城跡）。括弧の注を外して比べるので、どちらも OSM の1つに当たります。
  // 片方は必ず誤りで、どちらかは分かりません。
  const out = run();
  assert.equal(byRaw(out, "北海道", "城山試験公園（甲城跡）"), undefined);
  assert.equal(byRaw(out, "北海道", "城山試験公園（乙城跡）"), undefined);
});

test("注が花の名前のときは、そのまま一致するほうだけを採る", { skip }, () => {
  // 渋川市総合公園 と 渋川市総合公園（アジサイ）は、同じ場所です。
  const out = run();
  assert.ok(byRaw(out, "北海道", "渋谷試験公園"), "そのまま一致するほうが無い");
  assert.equal(byRaw(out, "北海道", "渋谷試験公園（あじさい）"), undefined,
    "注だけ違うものまで足しています（二重になります）");
});

test("同じ場所の別名どうしは、最初の1つだけを採る", { skip }, () => {
  const out = run();
  const got = ["別名一試験", "別名二試験"].filter((r) => byRaw(out, "北海道", r));
  assert.equal(got.length, 1, `別名が ${got.length}件 足されています`);
});

// --- 入れたあとの収録の中身 --------------------------------------------------

const index2 = JSON.parse(read("kb/index.json"));
const all2 = index2.shards.flatMap((s) => JSON.parse(read(`kb/${s.file}`)).spots);
const osm = all2.filter((s) => s.src === "osm-tourlist");

test("OpenStreetMap から入れたものが、並べ直しのあとも収録に残っている", () => {
  // 索引に登録しないと、reshard_kb.py が読まずに消します。言葉ではなく
  // 収録の中身を数えます。
  assert.ok(osm.length > 1000, `OSM 由来が ${osm.length}件しかありません`);
});

test("ODbL の表示が、出典に入っている", () => {
  // 「© OpenStreetMap contributors」の表示は必須です。画面の下の
  // 「データ: …」にそのまま出ます。消すと、利用条件に反します。
  const names = (index2.sources ?? []).map((x) => x.name);
  assert.ok(names.some((n) => /OpenStreetMap contributors/.test(n)),
    `出典に OSM の表示がありません: ${names.join(" / ")}`);
  const src = index2.sources.find((x) => /OpenStreetMap/.test(x.name));
  assert.match(src.url, /openstreetmap\.org\/copyright/);
});

test("OSM 由来の1件ごとに、元の番号と座標がある", () => {
  for (const s of osm) {
    assert.match(s.osm, /^(node|way)\/\d+$/, `${s.name} の元の番号が変です`);
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng), s.name);
    assert.ok(s.lat > 20 && s.lat < 46.6 && s.lng > 122 && s.lng < 154.5,
      `${s.name} の座標が日本の外です`);
  }
});

test("OSM 由来の名前に、「;」や全角スペースが残っていない", () => {
  // OSM の name には、複数の名前が「;」でつながっていることがあります。
  // そのまま出すと、画面に「麻績村福祉センター;みたらし温泉」と並びます。
  const bad = osm.filter((s) => /[;\u3000]/.test(s.name));
  assert.deepEqual(bad.map((s) => s.name), []);
});

test("OSM 由来に、宿・閉店・店・駅を入れていない", () => {
  const bad = osm.filter((s) => /(ホテル|旅館|民宿|山荘|ロッジ|閉店|閉館|株式会社)/.test(s.name)
    || (s.name.endsWith("駅") && !s.name.includes("道の駅")));
  assert.deepEqual(bad.map((s) => s.name), []);
});
