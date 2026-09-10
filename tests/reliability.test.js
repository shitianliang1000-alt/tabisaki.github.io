// 「どこまで裏が取れているか」を数える。
//
// このアプリの値打ちは「AIが旅程を書けること」ではありません。書くだけなら
// どこでもできます。実際に行けるかを確かめてあることが違いです。ところが
// 確かめた事実は旅程の中に散らばっていて、画面からは見えませんでした。
// 見えなければ、無いのと同じです。

import assert from "node:assert/strict";
import test from "node:test";

import { travelSource, tripReliability } from "../js/reliability.js";

const move = (extra) => ({ kind: "transit", ...extra });
const spot = (extra) => ({ kind: "spot", ...extra });

test("移動の出どころを見分ける", () => {
  assert.equal(travelSource(move({ routed: true, yahoo: {} })).label,
               "Yahoo!路線情報");
  assert.equal(travelSource(move({ routed: true })).label, "Googleの経路");
  assert.equal(travelSource(move({ routed: false })).label, "距離からの推定");
  assert.equal(travelSource(spot({})), null);
});

test("全部の裏が取れていれば、星は多い", () => {
  const r = tripReliability({
    slackMin: 200,
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      move({ routed: true, yahoo: {} }),
      spot({ estimated: false }),
      spot({ estimated: false }),
    ] }],
  });
  assert.equal(r.stars, 5);
  assert.equal(r.level, "high");
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks));
});

test("目安のままの区間があれば、そう言う", () => {
  const r = tripReliability({
    slackMin: 200,
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      move({ routed: false }),
      spot({ estimated: true }),
    ] }],
  });
  assert.ok(r.stars < 5, `星が ${r.stars} です`);
  const travel = r.checks.find((c) => c.label === "移動時間");
  assert.equal(travel.ok, false);
  assert.match(travel.detail, /2区間のうち1区間/);
  assert.match(travel.detail, /残り1区間は距離からの目安/);
  const hours = r.checks.find((c) => c.label === "営業時間");
  assert.match(hours.detail, /1か所のうち0か所/);
});

test("帰りが危ないときは、星を引く", () => {
  const base = {
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      spot({ estimated: false }),
    ] }],
  };
  const safe = tripReliability({ ...base, slackMin: 200 });
  const risky = tripReliability({ ...base, slackMin: 5 });
  assert.ok(risky.stars < safe.stars,
    `余裕5分でも ${risky.stars} 星のままです`);
  assert.equal(risky.checks.find((c) => c.label === "帰りの余裕").ok, false);
});

test("休みに当たりそうなら、そう言う", () => {
  const r = tripReliability({
    slackMin: 200,
    hoursWarnings: ["◯◯museum: 月曜が休みの可能性"],
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      spot({ estimated: false }),
    ] }],
  });
  const closed = r.checks.find((c) => c.label === "休みの日");
  assert.equal(closed.ok, false);
  assert.match(closed.detail, /1か所/);
});
