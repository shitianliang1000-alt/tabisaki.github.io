// 旅程を読み進めると、地図の印がついてくる（js/follow.js）。
// どの行を「読んでいる」とするかだけを、ここで決めています。

import { test } from "node:test";
import assert from "node:assert/strict";

import { readingRow } from "../js/follow.js";
import { widerThumb } from "../js/ui.js";

test("画面の上から3分の1の線にかかっている行を選ぶ", () => {
  const rows = [
    { id: "a", top: -200, bottom: 100 },
    { id: "b", top: 120, bottom: 420 },
    { id: "c", top: 440, bottom: 700 },
  ];
  // 0〜900 の3分の1は 300。b がかかっています。
  assert.equal(readingRow(rows, 0, 900), "b");
});

test("いちばん上に見えている行でも、ほとんど画面の外なら選ばない", () => {
  const rows = [
    { id: "a", top: -400, bottom: 40 },
    { id: "b", top: 60, bottom: 260 },
  ];
  // 線（300）にかかる行が無いので、線にいちばん近い b。
  assert.equal(readingRow(rows, 0, 900), "b");
});

test("見えている行が無ければ null", () => {
  assert.equal(readingRow([{ id: "a", top: 1000, bottom: 1200 }], 0, 900), null);
  assert.equal(readingRow([], 0, 900), null);
  assert.equal(readingRow(undefined, 0, 900), null);
});

test("箱が画面の途中から始まっていても、箱の中で測る", () => {
  const rows = [
    { id: "a", top: 100, bottom: 300 },
    { id: "b", top: 320, bottom: 600 },
  ];
  // 100〜1000 の3分の1は 400。
  assert.equal(readingRow(rows, 100, 1000), "b");
});

test("写真の縮小版は、幅640pxのものを頼む", () => {
  const u = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/320px-X.jpg";
  assert.equal(widerThumb(u),
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/640px-X.jpg");
});

test("もう十分に大きい縮小版や、縮小版でないURLはそのまま", () => {
  const big = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/800px-X.jpg";
  assert.equal(widerThumb(big), big);
  const orig = "https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg";
  assert.equal(widerThumb(orig), orig);
  assert.equal(widerThumb(null), "");
});
