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
//
// ただ、それだけでは足りませんでした。
// ------------------------------------------------------------------
// 変数の中身が px だったので、**利用者が字を大きくしても1pxも
// 動きません**。iOS の「文字を大きく」も、Android の文字サイズも、
// パソコンのフォントサイズ設定も効きません。Dynamic Type の名前を
// 出しておいて、中身は「Apple の表を写した固定値」でした。
//
// 変数の中身を rem にして、根（:root）の大きさを
//
//   ① ブラウザの既定の字（拡大・最小フォントサイズ設定）
//   ② iOS の Dynamic Type（font: -apple-system-body）
//   ③ アプリの中の倍率（--hig-type-scale。Android 向け）
//
// の3つから出すようにしました。ここでは、その3つがそろっていることと、
// px に戻っていないことを見張ります。

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const CSS_DIR = path.join(import.meta.dirname, "..", "css");
const read = (f) => fs.readFileSync(path.join(CSS_DIR, f), "utf8");
const files = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));

/**
 * 表にある大きさを rem にしたもの（基準は 16px）。
 *
 * 17px → 1.0625rem、13px → 0.8125rem、というだけです。既定のブラウザ
 * では見た目が変わりません。**変わるのは、利用者が字を大きくしたとき**
 * だけです。
 */
const ALLOWED_REM = new Set([
  0.6875, 0.75, 0.8125, 0.9375, 1, 1.0625, 1.25, 1.375, 1.5625, 1.75,
  2.125, 2.5625,
]);

test("字の大きさに、生の px を使っていない", () => {
  // ここが本題です。px で書いた字は、**利用者がどれだけ設定を
  // 変えても1pxも動きません**。Apple の表の値をそのまま px で置いて
  // いたので、「表を使っている」ことにはなっていても、Dynamic Type の
  // 中身（利用者の設定に追従する）が抜けていました。
  const bad = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      // 紙の指定（pt）は別です。紙には拡大設定がありません。
      if (/@media print/.test(line)) return;
      for (const m of line.matchAll(/font-size:\s*(\d+)px/g)) {
        bad.push(`${f}:${i + 1} ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, [],
    `px で書かれた字があります（rem にしてください）:\n${bad.join("\n")}`);
});

test("字の大きさは、変数か表にある rem だけ", () => {
  const bad = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/font-size:\s*([\d.]+)rem/g)) {
        if (!ALLOWED_REM.has(Number(m[1]))) bad.push(`${f}:${i + 1} ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, [], `表に無い大きさ:\n${bad.join("\n")}`);
});

test("字の大きさは、ほとんどが変数で書かれている", () => {
  // 生の値が増えていくと、表を直しても画面が変わらなくなります。
  let vars = 0;
  let raw = 0;
  for (const f of files) {
    const text = read(f);
    vars += [...text.matchAll(/font-size:\s*var\(--hig-t-/g)].length;
    raw += [...text.matchAll(/font-size:\s*[\d.]+(px|rem)/g)].length;
  }
  assert.ok(vars > 100, `変数で書かれた指定が ${vars} しかありません`);
  assert.ok(raw <= 2, `生の値が ${raw} か所あります（変数にしてください）`);
});

test("Dynamic Type の表どおりの値が入っている", () => {
  // 表の値そのものを固定します（16px 基準の rem に直したもの）。
  const css = read("hig.css");
  const want = {
    "--hig-t-large-title": "2.125rem", "--hig-t-title1": "1.75rem",
    "--hig-t-title2": "1.375rem", "--hig-t-title3": "1.25rem",
    "--hig-t-headline": "1.0625rem", "--hig-t-body": "1.0625rem",
    "--hig-t-callout": "1rem", "--hig-t-subhead": "0.9375rem",
    "--hig-t-footnote": "0.8125rem", "--hig-t-caption1": "0.75rem",
    "--hig-t-caption2": "0.6875rem",
  };
  for (const [name, value] of Object.entries(want)) {
    const re = new RegExp(`${name}:\\s*${value}`);
    assert.match(css, re, `${name} が ${value}（＝${Number(value.replace("rem", "")) * 16}px）ではありません`);
  }
});

test("いちばん小さい字が 11px 相当を下回らない", () => {
  // iOS の最小は 11pt です。これより小さい字は、読めない人が出ます。
  for (const f of files) {
    const css = read(f);
    for (const m of css.matchAll(/font-size:\s*([\d.]+)rem/g)) {
      assert.ok(Number(m[1]) * 16 >= 11 - 0.01,
        `${f} に ${m[0]}（${Number(m[1]) * 16}px 相当）があります`);
    }
  }
});

test("利用者の設定について、3つの道がそろっている", () => {
  // ① ブラウザの既定の字（rem の基準）
  // ② iOS の Dynamic Type（font: -apple-system-body）
  // ③ アプリの中の倍率（Android の Chrome では②が効きません）
  const css = read("hig.css");
  assert.match(css, /font-size:\s*calc\(100% \* var\(--hig-type-scale\)\)/,
    "根の大きさが、ブラウザの既定と倍率から出ていません");
  assert.match(css, /@supports \(font: -apple-system-body\)/,
    "iOS の Dynamic Type に直結していません");
  assert.match(css, /--hig-type-scale:\s*1/,
    "倍率の既定がありません");
});

test("当たり判定の大きさは、字と一緒に動かさない", () => {
  // 44pt は**指の大きさ**で決まっています。字を大きくしたからといって
  // 指が大きくなるわけではないので、ここは rem にしません。
  const css = read("hig.css");
  assert.match(css, /--hig-touch:\s*44px/,
    "44px の当たり判定が無い、または rem になっています");
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
