// 旅程を文字にして渡すテスト。
//
// 同行者に送るのは LINE やメールです。画面のとおりの時刻と場所が、
// そのまま貼れる形で出ること。空き時間の行は要りません。

import assert from "node:assert/strict";
import test from "node:test";

import { itineraryText } from "../js/share.js";

const itin = {
  title: "草津温泉",
  subtitle: "群馬県",
  days: [{
    date: new Date("2026-09-13T09:00"),
    items: [
      { kind: "transit", title: "東京駅 → 長野原草津口駅", detail: "約132分",
        start: new Date("2026-09-13T09:00"), end: new Date("2026-09-13T11:12") },
      { kind: "free", title: "空き",
        start: new Date("2026-09-13T11:12"), end: new Date("2026-09-13T11:30") },
      { kind: "spot", title: "草津温泉 湯畑",
        start: new Date("2026-09-13T12:16"), end: new Date("2026-09-13T13:44") },
      { kind: "meal", title: "昼食",
        start: new Date("2026-09-13T13:44"), end: new Date("2026-09-13T14:44") },
    ],
  }],
};

test("題・日付・時刻つきの行になる", () => {
  const text = itineraryText(itin);
  assert.match(text, /^草津温泉 · 群馬県\n/);
  assert.match(text, /■ 9月13日\(日\)/);
  assert.match(text, /9:00 🚃 東京駅 → 長野原草津口駅\n {6}約132分/);
  assert.match(text, /12:16 📍 草津温泉 湯畑（88分）/);
  assert.match(text, /13:44 🍽 昼食/);
});

test("空き時間は書かない", () => {
  assert.doesNotMatch(itineraryText(itin), /空き/);
});

test("複数日なら「n日目」が付き、リンクは末尾に", () => {
  const two = { ...itin, days: [itin.days[0], { ...itin.days[0], date: new Date("2026-09-14T09:00") }] };
  const text = itineraryText(two, { url: "https://example.test/?p=abc" });
  assert.match(text, /■ 1日目 9月13日\(日\)/);
  assert.match(text, /■ 2日目 9月14日\(月\)/);
  assert.ok(text.indexOf("https://example.test/?p=abc") > text.indexOf("2日目"));
});

test("保存から戻した文字列の日時でも落ちない", () => {
  const frozen = JSON.parse(JSON.stringify(itin));
  const text = itineraryText(frozen);
  assert.match(text, /12:16 📍 草津温泉 湯畑（88分）/);
});

test("旅程が空でも一文は返る", () => {
  assert.match(itineraryText({}), /旅さき/);
});
