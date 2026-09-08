// Yahoo!路線情報の読み取り。
//
// 電車・バスの時間は、ここが唯一の出どころです。読み違えても例外は
// 出ません。**0分の経路**という、もっともらしい嘘になって旅程に入ります。
// 実際にそうなっていました（新宿→箱根湯本が「所要0分」）。原因は2つ。
//
//   ・`class=[^"]*routeDetail` が、外側の class="elmRouteDetail" に当たり、
//     明細ではなく要約の部分だけを見ていた（駅が1件も取れない）
//   ・乗換駅の時刻が「10:39着」のように文字つきで、時刻だけの行を
//     探す当たり方では拾えなかった
//
// どちらも、保存した見本で固定します。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { firstYahooRoute, parseRouteDetail, parseSummary }
  from "../server/worker.js";

const html = await readFile(
  new URL("./fixtures/yahoo-tokyo-takayama.html", import.meta.url), "utf8");
const route = firstYahooRoute(html);

test("要約から、発着時刻と所要時間を読む", () => {
  const s = parseSummary(route);
  assert.equal(s.departure, "09:00");
  assert.equal(s.arrival, "13:12");
  assert.equal(s.minutes, 4 * 60 + 12);
  assert.equal(s.transfers, 1);
  assert.equal(s.fareYen, 15290);
  assert.equal(s.distanceKm, 532.7);
});

test("明細から、駅と乗車区間を読む", () => {
  const d = parseRouteDetail(route);
  assert.equal(d.departure, "09:00");
  assert.equal(d.arrival, "13:12");
  assert.equal(d.legs.length, 2, "乗車区間が取れていません");
  assert.equal(d.legs[0].from, "東京");
  assert.equal(d.legs[0].to, "名古屋");
  assert.match(d.legs[0].line, /のぞみ/);
  assert.equal(d.legs[1].to, "高山");
  assert.match(d.legs[1].line, /ひだ/);
});

test("乗換駅の、着と発を取り違えない", () => {
  const d = parseRouteDetail(route);
  assert.deepEqual(d.intermediateStops,
    [{ station: "名古屋", arrival: "10:39", departure: "10:48" }]);
  // 乗り換えの待ち時間は、着から発までです。ここが null だと
  // 「着いた瞬間に次に乗れる」ことになります。
  assert.equal(d.legs[0].arrival, "10:39");
  assert.equal(d.legs[1].departure, "10:48");
});

test("所要0分の区間を作らない", () => {
  const d = parseRouteDetail(route);
  for (const leg of d.legs) {
    assert.ok(leg.minutes > 0, `${leg.from}→${leg.to} が ${leg.minutes} 分です`);
  }
});
