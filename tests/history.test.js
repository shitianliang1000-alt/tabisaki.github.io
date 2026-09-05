// つくった旅程を覚えておく仕組みのテスト。
//
// 旅行サイトでいちばん使われるのは「前に作った旅程をもう一度開く」です。
// ここが壊れると、ブラウザを閉じた時点で全部消えます。

import assert from "node:assert/strict";
import test from "node:test";

import { MAX, addHistory, clearHistory, loadHistory, removeHistory, savedLabel }
  from "../js/history.js";

/** localStorage の代わり。テストのあいだだけ持ちます。 */
function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    _map: map,
  };
}

const entry = (title, extra = {}) => ({
  title, subtitle: "神奈川県", when: "日帰り",
  // 名前は js/app.js の formState() と同じにしておきます
  state: { dep: "2026-09-05T09:00", arr: "2026-09-05T19:00",
           from: "東京", to: "", ...extra },
});

test("何も無いところから始まる", () => {
  assert.deepEqual(loadHistory(fakeStore()), []);
});

test("足したものが、いちばん上に来る", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("箱根"), s);
  assert.deepEqual(loadHistory(s).map((x) => x.title), ["箱根", "鎌倉"]);
});

test("同じ旅は、増やさずに上書きする", () => {
  // 同じ旅を何度も作り直すのはふつうのことです。
  // そのたびに一覧が埋まると、探せなくなります。
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("箱根"), s);
  addHistory(entry("鎌倉"), s);
  assert.deepEqual(loadHistory(s).map((x) => x.title), ["鎌倉", "箱根"]);
});

test("日程が違えば、別の旅として持つ", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("鎌倉", { dep: "2026-10-01T09:00" }), s);
  assert.equal(loadHistory(s).length, 2);
});

test("出発地が違えば、別の旅として持つ", () => {
  // 同じ鎌倉でも、東京発と大阪発ではまったく別の旅程になります。
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("鎌倉", { from: "大阪" }), s);
  assert.equal(loadHistory(s).length, 2);
});

test("覚える件数には上限がある", () => {
  const s = fakeStore();
  for (let i = 0; i < MAX + 5; i++) addHistory(entry(`旅${i}`), s);
  const list = loadHistory(s);
  assert.equal(list.length, MAX);
  assert.equal(list[0].title, `旅${MAX + 4}`, "新しいものが残るはずです");
});

test("1件だけ消せる", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("箱根"), s);
  const id = loadHistory(s)[0].id;
  removeHistory(id, s);
  assert.deepEqual(loadHistory(s).map((x) => x.title), ["鎌倉"]);
});

test("全部消せる", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  clearHistory(s);
  assert.deepEqual(loadHistory(s), []);
});

test("壊れていても、落ちない", () => {
  // localStorage は、別のタブや拡張機能に書き換えられることがあります。
  const s = fakeStore();
  s.setItem("tabisaki.history", "{ こわれた");
  assert.deepEqual(loadHistory(s), []);
  s.setItem("tabisaki.history", '[{"no":"id"}]');
  assert.deepEqual(loadHistory(s), []);
});

test("題も条件も無いものは、覚えない", () => {
  const s = fakeStore();
  addHistory({ title: "", state: {} }, s);
  addHistory({ title: "鎌倉" }, s);
  assert.deepEqual(loadHistory(s), []);
});

test("いつ作ったかを、読める言葉にする", () => {
  const now = new Date("2026-09-10T12:00");
  const ago = (d) => now.getTime() - d * 86400000;
  assert.equal(savedLabel(ago(0), now), "今日");
  assert.equal(savedLabel(ago(1), now), "昨日");
  assert.equal(savedLabel(ago(3), now), "3日前");
  assert.match(savedLabel(ago(30), now), /月.*日/);
  assert.equal(savedLabel(undefined, now), "");
});
