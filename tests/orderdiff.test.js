// 回る順を変えたら、移動がどう変わったかを見せる（js/orderdiff.js）。
//
// 新しい旅程が出るだけでは、入れ替えて得だったのかが分かりません。
// 比べるのは、移動の合計・終わる時刻・落ちた立ち寄りの3つです。

import assert from "node:assert/strict";
import test from "node:test";

import { deltaWord, describeOrderDiff, fmtMinutes, orderDiff }
  from "../js/orderdiff.js";

// 時刻は端末の時計で書くので、テストも端末の時刻で作ります。
const at = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 9, 10, h, m);
};
const spot = (id, s, e) => ({ kind: "spot", spotId: id, title: id,
                             start: at(s), end: at(e) });
const ride = (s, e) => ({ kind: "transit", start: at(s), end: at(e) });

const before = { days: [{ items: [
  spot("寺", "09:00", "10:00"), ride("10:00", "10:50"),
  spot("海", "10:50", "12:00"), ride("12:00", "12:40"),
  spot("城", "12:40", "14:00"),
] }] };

test("移動が短くなったら、短くなったと言う", () => {
  const after = { days: [{ items: [
    spot("寺", "09:00", "10:00"), ride("10:00", "10:30"),
    spot("城", "10:30", "11:50"), ride("11:50", "12:20"),
    spot("海", "12:20", "13:30"),
  ] }] };
  const d = orderDiff(before, after);
  assert.equal(d.moveBefore, 90);
  assert.equal(d.moveAfter, 60);
  assert.equal(d.deltaMin, -30);
  assert.deepEqual(d.dropped, []);
  const t = describeOrderDiff(d);
  assert.equal(t.tone, "better");
  assert.equal(t.head, "移動の合計 1時間30分 → 1時間（30分短く）");
  assert.deepEqual(t.lines, ["終わり 14:00 → 13:30（30分早く）"]);
});

test("入らずに落ちた場所を名指しする", () => {
  const after = { days: [{ items: [
    spot("海", "09:00", "10:10"), ride("10:10", "11:40"),
    spot("寺", "11:40", "12:40"),
  ] }] };
  const d = orderDiff(before, after);
  assert.equal(d.deltaMin, 0);
  assert.deepEqual(d.dropped.map((s) => s.name), ["城"]);
  const t = describeOrderDiff(d);
  assert.equal(t.tone, "same");
  assert.ok(t.lines.at(-1).includes("城"));
});

test("何日もある旅は、変わった日だけ書く", () => {
  const two = { days: [before.days[0], { items: [
    spot("滝", "09:00", "10:00"), ride("10:00", "10:20"), spot("森", "10:20", "11:00"),
  ] }] };
  const after = { days: [before.days[0], { items: [
    spot("森", "09:00", "09:40"), ride("09:40", "10:30"), spot("滝", "10:30", "11:30"),
  ] }] };
  const t = describeOrderDiff(orderDiff(two, after));
  assert.equal(t.tone, "worse");
  assert.deepEqual(t.lines, ["2日目：移動 30分長く・終わり 11:00 → 11:30（30分遅く）"]);
});

test("比べられないときは何も出さない", () => {
  assert.equal(orderDiff(null, before), null);
  assert.equal(describeOrderDiff(null), null);
});

test("時間の言いかた", () => {
  assert.equal(fmtMinutes(45), "45分");
  assert.equal(fmtMinutes(120), "2時間");
  assert.equal(fmtMinutes(-95), "1時間35分");
  assert.equal(deltaWord(0), "変わらず");
  assert.equal(deltaWord(-10), "10分短く");
});
