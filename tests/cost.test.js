// 車の旅の費用。
//
// これまで車の旅でも、交通費は**鉄道の運賃の式**で出していました
// （fareFor(km, "TRANSIT")）。700kmを運転すると「¥14,040」と出ます。
// 鉄道の運賃です。ガソリンも高速もレンタカーも、1円も数えていません
// でした。「予算内です」と言われても、車旅では使えません。
//
// 数字はどれも幅があります。だから**前提をそのまま画面に書きます**
// （「15km/L・175円/L で計算」）。読む人が自分の車に置き換えられます。

import assert from "node:assert/strict";
import test from "node:test";

import { costBreakdown } from "../js/cost.js";

/** 1日ぶんの、運転する旅程。 */
function driveItin(km) {
  return {
    days: [{
      items: [
        { kind: "transit", drive: true, km },
        { kind: "spot", costYen: 500 },
      ],
    }],
  };
}

test("運転する区間を、鉄道の運賃で数えない", () => {
  const car = costBreakdown(driveItin(200), { transport: "car" });
  const keys = car.rows.map((r) => r.key);
  assert.ok(!keys.includes("transit"),
    "運転した区間が「交通」に鉄道の運賃として入っています");
  assert.ok(keys.includes("fuel"), "ガソリン代が入っていません");
});

test("ガソリン代が、距離と燃費から出ている", () => {
  const car = costBreakdown(driveItin(150), { transport: "car" });
  const fuel = car.rows.find((r) => r.key === "fuel");
  // 150km ÷ 15km/L × 175円/L = 1,750円
  assert.equal(fuel.yen, 1750);
  // 前提をそのまま書きます（読む人が自分の車に置き換えられるように）。
  assert.match(fuel.note, /15km\/L/);
  assert.match(fuel.note, /175円\/L/);
});

test("短い区間には、高速道路を乗せない", () => {
  // 街なかの10kmに高速代を足すと、行きもしない出費が乗ります。
  const car = costBreakdown(driveItin(10), { transport: "car" });
  assert.equal(car.rows.find((r) => r.key === "toll"), undefined);
});

test("車の費用は、人数ではなく台数で増える", () => {
  // 4人で乗っても、ガソリン代は1台ぶんです。人数倍すると、家族旅行の
  // 概算が4倍になります。
  const one = costBreakdown(driveItin(150), { transport: "car", people: 1 });
  const four = costBreakdown(driveItin(150), { transport: "car", people: 4 });
  const fuelOf = (c) => c.rows.find((r) => r.key === "fuel").yen;
  assert.equal(fuelOf(four), fuelOf(one), "4人ぶん数えています");
  assert.equal(four.cars, 1);
  // 6人なら2台です。
  const six = costBreakdown(driveItin(150), { transport: "car", people: 6 });
  assert.equal(six.cars, 2);
  assert.equal(fuelOf(six), fuelOf(one) * 2);
});

test("レンタカー代は、借りる旅のときだけ", () => {
  // 自分の車で行く旅にレンタカー代を足すと、行きもしない出費が乗ります。
  const own = costBreakdown(driveItin(150), { transport: "car" });
  assert.equal(own.rows.find((r) => r.key === "rental"), undefined);
  const rented = costBreakdown(driveItin(150), { transport: "transit+car" });
  assert.ok(rented.rows.find((r) => r.key === "rental")?.yen > 0);
});

test("駐車場を、数えたふりをしない", () => {
  // 場所ごとに無料と有料が入り混じり、料金を持っていません。作った
  // 数字を足すより「入っていません」と言うほうが役に立ちます。
  const car = costBreakdown(driveItin(150), { transport: "car" });
  assert.deepEqual(car.missing, ["駐車場"]);
  // 電車の旅では、その断り書きは出ません。
  const train = costBreakdown(
    { days: [{ items: [{ kind: "transit", km: 150 }] }] },
    { transport: "transit" });
  assert.deepEqual(train.missing, []);
});

test("電車の旅は、これまでどおり運賃で数える", () => {
  const train = costBreakdown(
    { days: [{ items: [{ kind: "transit", km: 150 }] }] },
    { transport: "transit" });
  const keys = train.rows.map((r) => r.key);
  assert.ok(keys.includes("transit"));
  assert.ok(!keys.includes("fuel"), "電車の旅にガソリン代が乗っています");
});
