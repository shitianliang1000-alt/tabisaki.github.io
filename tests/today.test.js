// 旅行中モードのテスト。
//
// 旅の当日、長い旅程はほとんど役に立ちません。知りたいのは一点だけです。
//
//   「いま、次に何をすればいいのか」
//
// そして、遅れているときに「どこを削れば帰れるのか」。
// ここも数えれば決まることなので、AIには聞きません。

import assert from "node:assert/strict";
import test from "node:test";

import { catchUp, currentStep, describeNext, todayOf } from "../js/today.js";
import { directionsFromHereUrl } from "../js/links.js";

const d = (s) => new Date(s);

const item = (kind, from, to, over = {}) => ({
  id: `${kind}-${from}`, kind,
  start: d(`2026-09-12T${from}`), end: d(`2026-09-12T${to}`),
  title: over.title ?? kind, ...over,
});

const ITIN = {
  days: [
    { date: d("2026-09-12T09:00"), items: [
      item("transit", "09:00", "10:00", { title: "東京駅 → 鎌倉駅" }),
      item("spot", "10:20", "11:20", { title: "鶴岡八幡宮", spotId: "s1",
        place: { id: "s1", name: "鶴岡八幡宮", lat: 35.326, lng: 139.556,
                 category: "神社" } }),
      item("transit", "11:20", "11:35", { title: "長谷寺へ移動" }),
      item("spot", "11:35", "12:35", { title: "長谷寺", spotId: "s2",
        place: { id: "s2", name: "長谷寺", lat: 35.312, lng: 139.532,
                 category: "寺院" } }),
      item("meal", "12:35", "13:35", { title: "昼食" }),
      item("spot", "13:50", "15:20", { title: "江ノ島", spotId: "s3",
        place: { id: "s3", name: "江ノ島", lat: 35.299, lng: 139.480,
                 category: "海岸" } }),
      item("transit", "15:20", "16:30", { title: "東京駅へ" }),
    ] },
    { date: d("2026-09-13T09:00"), items: [
      { id: "x", kind: "spot", title: "翌日",
        start: d("2026-09-13T10:00"), end: d("2026-09-13T11:00") },
    ] },
  ],
};

// --- その日を取り出す -------------------------------------------------------

test("いまの日付にあたる日を取り出す", () => {
  const t = todayOf(ITIN, d("2026-09-12T11:00"));
  assert.equal(t.index, 0);
  assert.equal(t.items.length, 7);
});

test("旅の前なら、初日を返す（そのことも分かるように）", () => {
  const t = todayOf(ITIN, d("2026-09-01T08:00"));
  assert.equal(t.index, 0);
  assert.equal(t.phase, "before");
});

test("旅の後なら、終わったと言う", () => {
  const t = todayOf(ITIN, d("2026-09-20T08:00"));
  assert.equal(t.phase, "after");
});

// --- いまどこにいるか -------------------------------------------------------

test("見学の最中なら、それがいまの予定になる", () => {
  const s = currentStep(ITIN, d("2026-09-12T10:45"));
  assert.equal(s.status, "during");
  assert.equal(s.current.title, "鶴岡八幡宮");
  assert.equal(s.next.title, "長谷寺へ移動");
});

test("予定と予定のあいだなら、次の予定までの時間を出す", () => {
  const s = currentStep(ITIN, d("2026-09-12T10:05"));
  assert.equal(s.status, "waiting");
  assert.equal(s.next.title, "鶴岡八幡宮");
  assert.equal(s.minutesUntil, 15);
});

test("その日が終わっていれば、そう言う", () => {
  const s = currentStep(ITIN, d("2026-09-12T18:00"));
  assert.equal(s.status, "done");
  assert.equal(s.next, null);
});

test("次の予定を、そのまま読める一文にする", () => {
  const s = currentStep(ITIN, d("2026-09-12T10:05"));
  const text = describeNext(s);
  assert.match(text, /鶴岡八幡宮/);
  assert.match(text, /15分|10:20/);
});

// --- 遅れの回復 -------------------------------------------------------------

test("遅れていなければ、何も提案しない", () => {
  const r = catchUp(ITIN, d("2026-09-12T10:45"), { endBy: d("2026-09-12T17:00") });
  assert.equal(r.lateMin, 0);
  assert.deepEqual(r.actions, []);
});

test("遅れは「着くはずだった時刻」との差で数える", () => {
  // 長谷寺は 11:35 着の予定。12:00 に着いたなら 25分 の遅れ。
  const r = catchUp(ITIN, d("2026-09-12T12:00"),
                    { endBy: d("2026-09-12T17:00"), arrivedAtId: "spot-11:35" });
  assert.equal(r.lateMin, 25);
});

test("滞在中の人を、遅れていると誤判定しない", () => {
  // 11:35 ちょうどに着いた人は、12:20 に滞在中でも遅れていません。
  const r = catchUp(ITIN, d("2026-09-12T11:35"),
                    { endBy: d("2026-09-12T17:00"), arrivedAtId: "spot-11:35" });
  assert.equal(r.lateMin, 0);
});

test("帰着に間に合うよう、どこを削るかを出す", () => {
  // 40分遅れ。帰りは 16:30 着で期限が 17:00 なら、余裕は30分しかない。
  const r = catchUp(ITIN, d("2026-09-12T12:15"), {
    endBy: d("2026-09-12T17:00"), arrivedAtId: "spot-11:35", lateMin: 40,
  });
  assert.ok(r.actions.length > 0, "回復の手が出ていません");
  const total = r.actions.reduce((a, x) => a + x.savesMin, 0);
  assert.ok(total >= 40 - 30,
    `削れる時間（${total}分）が足りません`);
  for (const a of r.actions) {
    assert.ok(a.text && a.savesMin > 0);
  }
});

test("短縮より先に、まだ行っていない場所の短縮を出す（過ぎた予定は削れない）", () => {
  const r = catchUp(ITIN, d("2026-09-12T12:15"), {
    endBy: d("2026-09-12T17:00"), arrivedAtId: "spot-11:35", lateMin: 60,
  });
  // 過ぎた「鶴岡八幡宮」は対象になりません
  assert.ok(!r.actions.some((a) => /鶴岡八幡宮/.test(a.text)),
    "過ぎた予定を削ろうとしています");
});

test("削っても間に合わないなら、そう言う（できないことをできると言わない）", () => {
  const r = catchUp(ITIN, d("2026-09-12T12:15"), {
    endBy: d("2026-09-12T17:00"), arrivedAtId: "spot-11:35", lateMin: 400,
  });
  assert.equal(r.enough, false);
  assert.match(r.summary, /間に合/);
});

test("旅程が空でも壊れない", () => {
  for (const bad of [null, undefined, {}, { days: [] }]) {
    assert.ok(todayOf(bad, new Date()));
    assert.ok(currentStep(bad, new Date()));
    assert.ok(catchUp(bad, new Date(), {}));
  }
});

// --- 地図アプリへの引き渡し -------------------------------------------------
// 案内そのものを自前で作る必要はありません。地図アプリのほうがよくできて
// います。ここでやるべきは、引き渡しを一手で済ませることです。

test("現在地からの経路は、起点を空にして地図アプリに任せる", () => {
  const url = directionsFromHereUrl({ lat: 35.31, lng: 139.55 });
  const u = new URL(url);
  assert.equal(u.searchParams.get("origin"), "",
    "起点を書いてしまうと、すでに動いた人には合いません");
  assert.equal(u.searchParams.get("destination"), "35.31,139.55");
  assert.equal(u.searchParams.get("travelmode"), "transit");
});

test("行き先の座標が無ければ、リンクを作らない", () => {
  // 押しても何も起きないリンクを出すほうが、出さないより悪いです。
  assert.equal(directionsFromHereUrl(null), "");
  assert.equal(directionsFromHereUrl({ name: "どこか" }), "");
  assert.equal(directionsFromHereUrl({ lat: 35.3, lng: null }), "");
});

test("移動手段は指定できる", () => {
  const u = new URL(directionsFromHereUrl({ lat: 35, lng: 139 }, "walking"));
  assert.equal(u.searchParams.get("travelmode"), "walking");
});
