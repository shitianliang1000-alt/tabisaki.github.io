// 座標つきの観光地一覧（いただいた xlsx）を入れる道具と、入れたあとの収録。
//
// 一覧そのものはリポジトリに入れていません（いただいたファイルです）。
// ここでは、名前の簡略化（祭りなどの追加表記を外す）の決まりと、
// 入れたあとの収録の中身を確かめます。
//
//   ① 催し・季節・注を外して、場所の名前だけにする
//   ② 外したら場所が残らないもの（催しだけ）は入れない
//   ③ 店・宿・運動施設を入れない
//   ④ 座標の取得元を1件ずつ持ち、Yahoo! の表示を出典に入れる
//   ⑤ 一覧の「まとめ名」の平均の座標を使わない（座標を作らない）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const tool = read("tools/import_tourism_coords.py");

function simplify(names) {
  const r = spawnSync("python3", ["-c",
    "import json,sys;sys.path.insert(0,'tools');"
    + "from import_tourism_coords import simplify;"
    + "print(json.dumps([simplify(x) for x in json.loads(sys.argv[1])],ensure_ascii=False))",
    JSON.stringify(names)], { cwd: root.pathname, encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

test("祭りなどの追加表記を外して、場所の名前にする", (t) => {
  const cases = {
    "なべくら高原・森の家 春の森を歩こう 新緑祭": "なべくら高原・森の家",
    "高橋まゆみ人形館・秋のテーマ展 冬の日の足跡": "高橋まゆみ人形館",
    "信州大芝高原の桜": "信州大芝高原",
    "テラマチマルシェ@高橋まゆみ人形館": "高橋まゆみ人形館",
    "花立山～秋の収穫祭～": "花立山",
    "松前公園・松前さくらまつり": "松前公園",
    "重要文化財 熊谷家住宅": "熊谷家住宅",
    "史跡・天然記念物 旧相模川橋脚 茅ヶ崎市": "旧相模川橋脚",
    "大山阿夫利神社のヤマザクラ 伊勢原市": "大山阿夫利神社",
    "五十崎凧博物館で凧作り・凧あげ体験": "五十崎凧博物館",
  };
  const got = simplify(Object.keys(cases));
  if (!got) { t.skip("python3 が使えません"); return; }
  assert.deepEqual(got, Object.values(cases));
});

test("施設の名前の中の催しの語では切らない・地名だけを残さない", (t) => {
  const got = simplify(["道の駅 ながおか花火館", "仙台・青葉まつり", "新緑祭",
    "挑戦・体験・発見！フォトロゲイニングin新城", "家族湯ゆぅ～ゆぅ～",
    "大山 伊勢原市"]);
  if (!got) { t.skip("python3 が使えません"); return; }
  assert.equal(got[0], "道の駅 ながおか花火館");
  assert.equal(got[1], null);        // 「仙台」だけが残るものは入れない
  assert.equal(got[2], null);        // 催しだけ
  assert.equal(got[3], null);
  assert.ok(got[4].startsWith("家族湯ゆぅ"));   // かなの後ろの～は伸ばす音
  assert.equal(got[5], "大山");
});

test("まとめ名（平均の座標）を使わない", () => {
  // 一覧の「まとめ名」は名前の頭で機械的にまとめた列で、270組は座標が
  // メンバーの平均でした。平均はどの場所でもない点です。
  assert.match(tool, /まとめ名（代表名）」の列は使いません/);
  assert.doesNotMatch(tool, /sheets\.get\("代表名まとめ"/);
});

const index = JSON.parse(read("kb/index.json"));
const all = index.shards.flatMap((s) => JSON.parse(read(`kb/${s.file}`)).spots);
const mine = all.filter((s) => s.src === "tourlist-geocoded");

test("入れたものが、並べ直しのあとも収録に残っている", () => {
  assert.ok(mine.length > 5000, `${mine.length}件しかありません`);
  for (const s of mine.slice(0, 2000)) {
    assert.ok(s.geo, `${s.name} に取得元がありません`);
  }
});

test("Yahoo! と国土地理院の表示が、出典に入っている", () => {
  const names = (index.sources ?? []).map((x) => x.name);
  assert.ok(names.includes("Web Services by Yahoo! JAPAN"));
  assert.ok(names.includes("国土地理院"));
});

test("店・宿・運動施設を入れない", () => {
  const bad = mine.filter((s) =>
    /(ホテル|旅館|民宿|ペンション|レストラン|食事処|カフェ|喫茶|居酒屋|株式会社|テニス|野球場|体育館)/
      .test(s.name));
  assert.deepEqual(bad.map((s) => s.name), []);
});

test("名前を外したものは、一覧の名前を残している", () => {
  const simplified = mine.filter((s) => s.listedAs);
  assert.ok(simplified.length > 0);
  for (const s of simplified) assert.notEqual(s.name, s.listedAs);
});
