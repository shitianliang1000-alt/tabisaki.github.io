// 旅行中モード（js/tripmode.js）。
//
// 端末に覚えて、開き直してもそのまま始まること。旅が終わったら
// 自然に外れること。

import assert from "node:assert/strict";
import test from "node:test";

import { TRIP_MODE_KEY, clearTripMode, laterToday, loadTripMode,
         saveTripMode, tripOver } from "../js/tripmode.js";

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v),
           removeItem: (k) => m.delete(k) };
}

const at = (h, m = 0) => new Date(2026, 9, 10, h, m);
const item = (id, kind, s, e) => ({ id, kind, title: id, start: s, end: e });
const itin = { days: [{ date: at(0), items: [
  item("a", "spot", at(9), at(10)),
  item("r1", "transit", at(10), at(10, 30)),
  item("b", "spot", at(10, 30), at(12)),
  item("c", "meal", at(12), at(13)),
] }] };
const trip = { arriveBy: at(18) };

test("覚えて、開き直したときに同じ旅程を返す", () => {
  const s = memStorage();
  assert.equal(saveTripMode(itin, trip, s), true);
  const got = loadTripMode(s, at(11));
  assert.equal(got.itin.days[0].items.length, 4);
  // 日時は日時に戻っています（文字のままだと時刻の比較が狂います）。
  assert.ok(got.itin.days[0].items[0].start instanceof Date);
  assert.ok(got.trip.arriveBy instanceof Date);
  clearTripMode(s);
  assert.equal(loadTripMode(s, at(11)), null);
});

test("旅が終わっていたら外れて、覚えていたものも消える", () => {
  const s = memStorage();
  saveTripMode(itin, trip, s);
  assert.equal(tripOver(itin, at(18)), false);
  const nextDay = new Date(2026, 9, 11, 9);
  assert.equal(tripOver(itin, nextDay), true);
  assert.equal(loadTripMode(s, nextDay), null);
  assert.equal(s.getItem(TRIP_MODE_KEY), null);
});

test("壊れた中身では始めない", () => {
  const s = memStorage({ [TRIP_MODE_KEY]: "{oops" });
  assert.equal(loadTripMode(s, at(11)), null);
  assert.equal(s.getItem(TRIP_MODE_KEY), null);
  const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
  assert.equal(loadTripMode(broken), null);
  assert.equal(saveTripMode(itin, trip, broken), false);
});

test("このあとの予定は、いまと次を除いた残り", () => {
  const step = { day: 0, current: itin.days[0].items[0],
                 next: itin.days[0].items[1] };
  assert.deepEqual(laterToday(itin, step).map((i) => i.id), ["b", "c"]);
  assert.deepEqual(laterToday(itin, { day: 5 }), []);
});
