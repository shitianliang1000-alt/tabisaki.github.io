// 県ごとの「観光地の名前の一覧」（xlsx）を取り込んだあとの、線引き。
//
// もらったファイルは2列だけでした（都道府県・観光地名）。座標も分類も
// 出典の名前もありません。5万8千件のうち、座標を確かめて足せたのは
// 2千件ほどです。ここで確かめたいのは3つです。
//
//   ① **座標を作っていないこと。** 名前だけの行を、それらしい場所に
//      置いていないこと。
//   ② **閉まっている所・泊まる所・行き先でないものを入れていないこと。**
//      一覧には【閉店】【閉館】が実際に混ざっていました。
//   ③ **入れたものが、並べ直しのあとも残ること。** 索引に登録しないと
//      reshard_kb.py が読まずに消します（実際に2,020件が消えました）。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const tool = read("tools/import_tourism_list.py");
const index = JSON.parse(read("kb/index.json"));

const SRC = "wikipedia-tourlist";
const all = index.shards.flatMap((s) => JSON.parse(read(`kb/${s.file}`)).spots);
const mine = all.filter((s) => s.src === SRC);

test("入れたものが、並べ直しのあとも収録に残っている", () => {
  // 取り込みが「収録 N件になりました」と言っても、索引に登録して
  // いなければ、並べ直しが読まずに消します。言葉ではなく、収録の中身を
  // 数えます。
  assert.ok(mine.length > 1000,
    `この一覧から入ったものが ${mine.length}件しかありません`
    + "（並べ直しで消えていないか確かめてください）");
});

test("索引と、段のファイルが食い違わない", () => {
  const files = fs.readdirSync(new URL("kb/", root))
    .filter((f) => /^spots-.*\.json$/.test(f)).sort();
  const listed = index.shards.map((s) => s.file).sort();
  assert.deepEqual(listed, files,
    "索引に無い段があるか、索引にあるのにファイルの無い段があります");
  for (const shard of index.shards) {
    const n = JSON.parse(read(`kb/${shard.file}`)).spots.length;
    assert.equal(shard.count, n, `${shard.file} の件数が索引と違います`);
  }
  if (index.counts?.spots !== undefined) {
    assert.equal(index.counts.spots, all.length,
      "索引の総数と、実際の件数が違います");
  }
});

test("座標を作っていない（出典の記事の座標だけ）", () => {
  for (const s of mine) {
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng), s.name);
    assert.ok(s.lat > 20 && s.lat < 46.6 && s.lng > 122 && s.lng < 154.5,
      `${s.name} の座標が日本の外です`);
    // 座標の出どころ（ウィキペディアの記事）へたどれること。
    assert.ok(s.wikipedia, `${s.name} に記事名がありません`);
  }
  assert.match(tool, /座標は作りません/);
  assert.match(tool, /coords\.json/);
});

test("県が合うものを先に採り、食い違いは記録して入れる", () => {
  // 「氷川神社」「八幡宮」のような名前は、どの県にもあります。
  // 決め方は OSM・Overture と共通の place_match.select です。
  //   ・県が合う記事があれば、それを採る（同じ県に複数なら決めない）
  //   ・無ければ全国で1つ、複数なら一覧の県にいちばん近いもの
  assert.match(tool, /from place_match import select/);
  assert.match(tool, /def in_prefecture/);
  assert.match(tool, /決められない/);
  // 食い違いは、一覧の県を listedIn に残します（あとで見直せるように）。
  assert.match(tool, /spot\["listedIn"\] = pref/);
  // 入れたものの座標が、エリアの近くにあること（遠すぎるものは置かない）。
  const regions = JSON.parse(read("kb/regions.json")).regions;
  const byId = new Map(regions.map((r) => [r.id, r]));
  for (const s of mine.slice(0, 500)) {
    const r = byId.get(s.regionId);
    assert.ok(r, `${s.name} のエリア ${s.regionId} がありません`);
    const km = Math.hypot((s.lat - r.lat) * 111,
      (s.lng - r.lng) * 111 * Math.cos((r.lat * Math.PI) / 180));
    assert.ok(km <= 100, `${s.name} がエリア ${r.name} から ${km.toFixed(0)}km`);
  }
});

test("閉まっている所・泊まる所・行き先でないものを入れない", () => {
  const bad = mine.filter((s) => /(閉店|閉館|閉園|休業|廃止)/.test(s.name)
    || /(ホテル|旅館|民宿|山荘|ロッジ|ペンション|ヒュッテ)/.test(s.name)
    || /(株式会社|有限会社|合資会社)/.test(s.name)
    || (s.name.endsWith("駅") && !s.name.includes("道の駅")));
  assert.deepEqual(bad.map((s) => s.name), []);
  // 一覧の【閉店】【閉館】を見て外していること。**入れると、閉まっている
  // 所へ案内します。**
  assert.match(tool, /閉店\|閉館/);
  assert.match(tool, /閉まっている所へ案内しない/);
});

test("表示する名前でも、行き先かを確かめる（括弧を外した後）", () => {
  // 一覧の名前は「沢入駅（アジサイ）」のように括弧が付いています。
  // 括弧を外す前だけ確かめていたら、駅が5件漏れました。
  assert.match(tool, /表示する名前でも、行き先かどうかを確かめます/);
  assert.match(tool, /looks_unusable\(shown, lat, lng\)/);
});

test("ウィキペディアの一覧の取り込みと、印を分けている", () => {
  // 同じ印にすると、あちらを走らせたときにこちらのぶんが消えます。
  assert.match(tool, /SRC = "wikipedia-tourlist"/);
  assert.ok(!/SRC = "wikipedia"/.test(tool));
  assert.match(read("tools/import_wikipedia_lists.py"), /SRC = "wikipedia"/);
  // 前回のぶんは、ファイル名ではなく印で取り除く（並べ直しのあとは
  // 県のファイルへ移っています）。
  assert.match(tool, /x\.get\("src"\) != SRC/);
  assert.match(tool, /前回のぶん/);
});

test("索引への登録を、2つの取り込みで共有している", () => {
  const wp = read("tools/import_wikipedia_lists.py");
  assert.match(wp, /def register\(shards, regions, extra_sources=\(\)\)/);
  assert.match(wp, /register\(shards, regions\)/);
  assert.match(tool, /register\(shards, regions_doc/);
  // 消したファイルの登録を残さない（並べ直しが無いファイルを読もうとする）。
  assert.match(wp, /os\.path\.exists\(os\.path\.join\(WEB, "kb", s\["file"\]\)\)/);
});

test("標準ライブラリだけで xlsx を読む", () => {
  // ほかの道具（tools/*.py）は標準ライブラリだけで動きます。ここだけ
  // openpyxl を要求すると、走らせる前に躓きます。
  assert.match(tool, /import zipfile/);
  assert.ok(!/import openpyxl|from openpyxl/.test(tool),
    "openpyxl を要求しています");
});

test("出典は Wikipedia とだけ書く（この一覧の名前は写していない）", () => {
  assert.match(tool, /Wikipedia とだけ書きます/);
  for (const s of mine.slice(0, 300)) {
    assert.ok(!s.source || s.source === "external", s.name);
  }
});

const python = spawnSync("python3", ["--version"]);
test("【閉店】【閉館】の札を、実際に見分ける", {
  skip: python.error || python.status !== 0
    ? "python3 がありません" : false,
}, () => {
  const code = `
import sys, json
sys.path.insert(0, "tools")
from import_tourism_list import clean_name
cases = ["【閉店】Orii gallery八ノ蔵", "【閉館】亀谷温泉 白樺の湯",
         "【藤沢市】片瀬東浜海水浴場", "片瀬東浜海水浴場", "亀谷温泉（休業中）",
         "三菱原子燃料株式会社", "ちりめん漁体験", "玉造温泉夏まつり",
         "白馬山荘", "羊蹄山（蝦夷富士）"]
print(json.dumps([clean_name(c) for c in cases], ensure_ascii=False))`;
  const r = spawnSync("python3", ["-c", code], { cwd: root.pathname,
    encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got, [
    null,                     // 閉店
    null,                     // 閉館
    "片瀬東浜海水浴場",         // 【藤沢市】はエリアの札。外して残す
    "片瀬東浜海水浴場",
    null,                     // （休業中）
    null,                     // 会社
    null,                     // 体験
    null,                     // 催し
    null,                     // 山荘（泊まる所）
    // 括弧の注は残す（突き合わせで外す）。NFKC で全角括弧が半角になる。
    "羊蹄山(蝦夷富士)",
  ]);
});

// --- 画面の下に出る「データ: …」の出典 ---------------------------------------
//
// 出典の名前は、そのまま画面に並びます（js/app.js の renderAttribution）。
// ウィキペディアの出典が「Wikipedia（文化財・灯台・城・道の駅・滝の一覧）」と
// 「Wikipedia」の2つ並んでいました。どの一覧から取ったかは、利用する側には
// 関係がありません。「Wikipedia」でまとめます。

test("出典に、Wikipedia が1つだけ出る", () => {
  const names = (index.sources ?? []).map((x) => x.name);
  const wiki = names.filter((n) => /wikipedia/i.test(n));
  assert.deepEqual(wiki, ["Wikipedia"],
    `Wikipedia の出典が ${JSON.stringify(wiki)} です（1つにまとめます）`);
  // 同じ名前が2つ並ばないこと（画面にそのまま出ます）。
  assert.equal(new Set(names).size, names.length,
    `同じ名前の出典が並んでいます: ${names.join(" / ")}`);
});

test("各都道府県の公式観光サイトを、出典に入れている", () => {
  // 一覧の出どころです。名前・座標・説明は写していませんが、「観光地
  // として挙がっている」ことの確認に使っているので、利用する側にも
  // 見えるようにします（ご指示がありました）。
  const names = (index.sources ?? []).map((x) => x.name);
  assert.ok(names.includes("各都道府県の公式観光サイト"),
    `出典に入っていません: ${names.join(" / ")}`);
  assert.match(tool, /EXTRA_SOURCES/);
  assert.match(tool, /register\(shards, regions_doc, EXTRA_SOURCES\)/);
});

test("旧い出典の名前を、取り込みのたびに統合する", () => {
  // 別の道具（import_csv.py）が書いた旧い名前が残っていても、
  // register() が「Wikipedia」に直します。
  const wp = read("tools/import_wikipedia_lists.py");
  assert.match(wp, /LEGACY_SOURCE_NAMES/);
  assert.match(wp, /def unify_sources/);
  assert.match(wp, /unify_sources\(index\.get\("sources", \[\]\)/);
  const csv = read("tools/import_csv.py");
  assert.ok(!/Wikipedia（文化財/.test(csv.replace(/\/\/.*|#.*/g, "")
    .replace(/LEGACY.*/g, "")), "import_csv.py が旧い名前を書いています");
});
