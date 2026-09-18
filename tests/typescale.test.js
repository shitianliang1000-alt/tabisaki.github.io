// 字の大きさの倍率が、ちゃんと保存され、当たっているか。
//
// 字は rem で書いてあり、根（:root）の大きさについていきます。根は
// ブラウザの既定の字と、iOS の Dynamic Type から決まります。ところが
// **Android の Chrome では Dynamic Type が効きません**（
// font: -apple-system-body を解釈しません）。OSの設定の場所を知らない
// 人もいます。そこでアプリの中にも倍率を置きました。
//
// ここで確かめたいのは、壊れた値で画面が読めなくならないことです。
// 0 や負の値が入ると、字が消えます。

import assert from "node:assert/strict";
import test from "node:test";

import {
  TYPE_SCALES, TYPE_SCALE_KEY, applyTypeScale, initTypeScale, loadTypeScale,
  saveTypeScale,
} from "../js/typescale.js";

/** localStorage の代わり。 */
function fakeStore(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    has: (k) => map.has(k),
    size: () => map.size,
  };
}

/** documentElement の代わり。 */
function fakeRoot() {
  const props = new Map();
  return {
    style: {
      setProperty: (k, v) => props.set(k, v),
    },
    get: (k) => props.get(k),
  };
}

test("選べる段が、読み分けられる刻みになっている", () => {
  // 細かく刻んでも選び分けられません。標準・やや大きい・大きい・特大。
  assert.equal(TYPE_SCALES.length, 4);
  assert.equal(TYPE_SCALES[0].value, 1);
  for (let i = 1; i < TYPE_SCALES.length; i++) {
    const step = TYPE_SCALES[i].value - TYPE_SCALES[i - 1].value;
    assert.ok(step >= 0.1, `${TYPE_SCALES[i].label} の差が ${step} しかありません`);
  }
  // いちばん上でも2倍は超えません（超えると1行に何も入りません）。
  assert.ok(TYPE_SCALES.at(-1).value <= 2);
});

test("何も保存していなければ、標準", () => {
  assert.equal(loadTypeScale(fakeStore()), 1);
});

test("保存して、読み戻せる", () => {
  const s = fakeStore();
  assert.equal(saveTypeScale(1.3, s), 1.3);
  assert.equal(loadTypeScale(s), 1.3);
});

test("標準に戻したら、鍵ごと消す", () => {
  // 残しておくと「設定した覚えはないのに値がある」状態になります。
  const s = fakeStore();
  saveTypeScale(1.5, s);
  assert.equal(s.has(TYPE_SCALE_KEY), true);
  saveTypeScale(1, s);
  assert.equal(s.has(TYPE_SCALE_KEY), false);
  assert.equal(s.size(), 0);
});

test("壊れた値で、字が消えない", () => {
  // 0 を入れられると字が消えます。負の値でも同じです。localStorage は
  // 利用者が触れる場所なので、読むときに必ず収めます。
  assert.equal(loadTypeScale(fakeStore({ [TYPE_SCALE_KEY]: "0" })), 1);
  assert.equal(loadTypeScale(fakeStore({ [TYPE_SCALE_KEY]: "-3" })), 1);
  assert.equal(loadTypeScale(fakeStore({ [TYPE_SCALE_KEY]: "abc" })), 1);
  // 大きすぎる値も収めます（1行に1文字しか入らない画面は使えません）。
  assert.equal(loadTypeScale(fakeStore({ [TYPE_SCALE_KEY]: "9" })), 2);
  // 保存するときも同じです。
  assert.equal(saveTypeScale(0, fakeStore()), 1);
  assert.equal(saveTypeScale(99, fakeStore()), 2);
});

test("保存できない環境でも、止まらない", () => {
  // 非公開ウィンドウ、保存を切っている環境。読めなくても標準で動きます。
  const broken = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.equal(loadTypeScale(broken), 1);
  assert.equal(saveTypeScale(1.3, broken), 1.3, "この場では効くべきです");
});

test("倍率は、根の変数として当たる", () => {
  // CSS は calc(100% * var(--hig-type-scale)) で根の大きさを出すので、
  // ここを書き換えれば rem で書いた字が全部ついてきます。
  const root = fakeRoot();
  applyTypeScale(1.3, root);
  assert.equal(root.get("--hig-type-scale"), "1.3");
});

test("起動時に、保存してある倍率が当たる", () => {
  const store = fakeStore({ [TYPE_SCALE_KEY]: "1.15" });
  const root = fakeRoot();
  assert.equal(initTypeScale(store, root), 1.15);
  assert.equal(root.get("--hig-type-scale"), "1.15");
});
