// ローマ字の地名と、乗り物の指定を読み取る。
//
// 画面にこう入力されていました。
//
//     I want to visit around Sendai
//
// 出てきたのは **旭川市・函館市（北海道）** です。仙台から700km離れて
// います。地名は収録の表記（「仙台市」）をそのまま探すので "Sendai" は
// 一致せず、地名の指定が無かったことになって点の高い順に返ります。
// 黙って別の場所を出すのが、いちばん困ります。

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRomaji, placeFromRomaji, withJapanesePlaces }
  from "../js/romaji.js";
import { readIntent } from "../js/intent.js";

test("ローマ字の地名を、収録の表記に読み替える", () => {
  assert.equal(placeFromRomaji("Sendai"), "仙台市");
  assert.equal(placeFromRomaji("kyoto"), "京都府");
  assert.equal(placeFromRomaji("HOKKAIDO"), "北海道");
  assert.equal(placeFromRomaji("hakone"), "箱根");
  assert.equal(placeFromRomaji("banana"), null);
});

test("長音の書きかたが違っても、同じ場所として読む", () => {
  // Tokyo / Tôkyô / Toukyou / Tookyoo は、どれも同じつもりで書かれます。
  for (const w of ["Tokyo", "Tôkyô", "Toukyou", "Tookyoo", "TOKYO"]) {
    assert.equal(placeFromRomaji(w), "東京都", `${w} が読めていません`);
  }
  assert.equal(normalizeRomaji("Kyūshū"), normalizeRomaji("kyushu"));
});

test("元の文は捨てず、読み替えを足す", () => {
  assert.equal(withJapanesePlaces("I want to visit around Sendai"),
    "I want to visit around Sendai 仙台市");
  // 日本語で書いてあるなら、二重に足しません。
  assert.equal(withJapanesePlaces("仙台に行きたい"), "仙台に行きたい");
  // 地名が無ければ、そのままです。
  assert.equal(withJapanesePlaces("温泉でゆっくり"), "温泉でゆっくり");
});

// --- 乗り物の指定 -----------------------------------------------------------
//
// 「ツーリングをしたい」と書いても素通りしていました。文の中の語は
// スポット名との照合にしか使われないので、合うスポットが無ければ
// 無視されます。バイクで回りたい人に、電車の時刻表で組んだ旅程が
// 出ていました。

test("ツーリング・レンタカーは、道のりで見る", () => {
  assert.equal(readIntent("ツーリングをしたい").transport, "car");
  assert.equal(readIntent("レンタカーで九州を回る").transport, "car");
  assert.equal(readIntent("I want to go by car").transport, "car");
  assert.match(readIntent("ツーリングをしたい").notes[0], /バイク/);
});

test("歩き・自転車は、歩く速さで見る", () => {
  assert.equal(readIntent("歩いて京都を見たい").transport, "walk");
  assert.equal(readIntent("サイクリングしたい").transport, "walk");
});

test("電車の指定は、公共交通として見る", () => {
  assert.equal(readIntent("電車で回りたい").transport, "transit");
  assert.equal(readIntent("青春18きっぷで行く").transport, "transit");
});

test("夜行は、狙っている列車として読み取る", () => {
  // 夜行は毎日同じ時刻で走るので、旅程の区間として組めます
  // （js/night-train.js）。ここでは「どれを狙っているか」だけを拾います。
  assert.equal(readIntent("サンライズに乗って山陰へ").nightTrain, "any");
  assert.equal(readIntent("サンライズ出雲で出雲大社").nightTrain,
    "sunrise-izumo");
  assert.equal(readIntent("サンライズ瀬戸で四国へ").nightTrain, "sunrise-seto");
  // 乗り物までは決めません。現地では在来線もバスも使います。
  assert.equal(readIntent("サンライズに乗って山陰へ").transport, null);
});

test("組み込めない列車は、組み込めないと言う", () => {
  // 観光列車は運転日が限られ、指定席が要ります。時刻表からは
  // 「その日に走るか」が分かりません。分かるところまでを伝えます。
  const scenic = readIntent("観光列車に乗りたい");
  assert.ok(scenic.notes.some((n) => /運転日/.test(n)),
    "観光列車の注意が出ていません");
  assert.equal(scenic.nightTrain, null);
});

test("何も書かれていなければ、何も決めない", () => {
  const plain = readIntent("温泉でゆっくりしたい");
  assert.equal(plain.transport, null);
  assert.deepEqual(plain.notes, []);
});
