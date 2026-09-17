// 字の大きさを、Apple の表の外に出さない。
//
// Human Interface Guidelines / Typography には、プラットフォームごとに
// 「どの大きさをどの段に使うか」の表があります（iOS の既定なら
// 本文 17pt、Footnote 13pt、Caption 2 が 11pt で最小）。
//
// ところが CSS には **14px が 35 か所**ありました。14px は Apple の
// どの表にも無い大きさです。こういう値が混ざると、段が増えるのでは
// なく**段の意味が消えます**。「なんとなく小さい字」が何種類もある
// 状態になり、どれが補助でどれが本文なのか、読む側にも書く側にも
// 分からなくなります。10px も1か所ありました（iOS の最小は 11pt）。
//
// そこで、大きさは css/hig.css の :root に置いた変数だけを使うことに
// して、ここで見張ります。新しい画面を足すときに 14px と書いても、
// ここで落ちます。

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const CSS_DIR = path.join(import.meta.dirname, "..", "css");
const read = (f) => fs.readFileSync(path.join(CSS_DIR, f), "utf8");
const files = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));

/** 表にある大きさ（iOS の既定と、広い画面のぶん）。 */
const ALLOWED = new Set([11, 12, 13, 15, 16, 17, 20, 22, 25, 28, 34, 41]);

test("字の大きさは、変数か表にある値だけ", () => {
  const bad = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/font-size:\s*(\d+)px/g)) {
        if (!ALLOWED.has(Number(m[1]))) bad.push(`${f}:${i + 1} ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, [], `表に無い大きさ:\n${bad.join("\n")}`);
});

test("字の大きさは、ほとんどが変数で書かれている", () => {
  // 生の px が増えていくと、表を直しても画面が変わらなくなります。
  let vars = 0;
  let raw = 0;
  for (const f of files) {
    const text = read(f);
    vars += [...text.matchAll(/font-size:\s*var\(--hig-t-/g)].length;
    raw += [...text.matchAll(/font-size:\s*\d+px/g)].length;
  }
  assert.ok(vars > 100, `変数で書かれた指定が ${vars} しかありません`);
  assert.ok(raw <= 2, `生の px が ${raw} か所あります（変数にしてください）`);
});

test("Dynamic Type の表どおりの値が入っている", () => {
  // 表の値そのものを固定します（うっかり別の値に書き換えられたら落ちます）。
  const css = read("hig.css");
  const want = {
    "--hig-t-large-title": "34px", "--hig-t-title1": "28px",
    "--hig-t-title2": "22px", "--hig-t-title3": "20px",
    "--hig-t-headline": "17px", "--hig-t-body": "17px",
    "--hig-t-callout": "16px", "--hig-t-subhead": "15px",
    "--hig-t-footnote": "13px", "--hig-t-caption1": "12px",
    "--hig-t-caption2": "11px",
  };
  for (const [name, value] of Object.entries(want)) {
    const re = new RegExp(`${name}:\\s*${value}`);
    assert.match(css, re, `${name} が ${value} ではありません`);
  }
});

test("いちばん小さい字が 11px を下回らない", () => {
  // iOS の最小は 11pt です。これより小さい字は、読めない人が出ます。
  for (const f of files) {
    const css = read(f);
    for (const m of css.matchAll(/font-size:\s*(\d+)px/g)) {
      assert.ok(Number(m[1]) >= 11, `${f} に ${m[0]} があります`);
    }
  }
});

test("細い太さを使っていない", () => {
  // ガイドラインが名指しで避けるように書いています
  // （Ultralight / Thin / Light。小さい字ではとくに読めません）。
  for (const f of files) {
    const css = read(f);
    for (const m of css.matchAll(/font-weight:\s*(\d+)/g)) {
      assert.ok(Number(m[1]) >= 400, `${f} に font-weight: ${m[1]} があります`);
    }
    assert.doesNotMatch(css, /font-weight:\s*(lighter|thin|light)\b/);
  }
});
