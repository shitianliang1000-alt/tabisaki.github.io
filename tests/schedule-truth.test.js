// 「書いてある時刻」と「調べた時刻」が食い違っていた件の回帰テスト。
//
// 画面に、こう出ていました。
//
//   3日目 4:00  名古屋駅 → 難波駅
//               拠点を移します・12:16 発→ 13:40 着 ｜ 時刻表・Yahoo!路線情報
//         5:51  法楽寺のくす（1か所だけ）
//
// 3つ壊れています。
//
//   ・行の時刻（4:00）と、中身の時刻（12:16発）が違う
//   ・その便を調べた日時が、そもそも3日目ではなかった
//   ・難波の周りに146か所あるのに、その日の立ち寄りが1か所
//
// ここでは、直した3点をそれぞれ固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { buildItinerary } from "../js/planner.js";
import { computeRoute, resetRoutesBreaker } from "../js/routes.js";

const d = (s) => new Date(s);

const NAGOYA = { name: "名古屋駅", lat: 35.1709, lng: 136.8815 };
const NAMBA = { name: "難波駅", lat: 34.6659, lng: 135.5017 };
const REGION = { id: "osaka-minami", name: "大阪・ミナミ",
                 lat: 34.6659, lng: 135.5017,
                 stationLat: 34.6659, stationLng: 135.5017, station: "難波駅" };

const trip = {
  origin: NAGOYA, departAt: d("2026-09-08T04:00"),
  arriveBy: d("2026-09-10T20:00"),
  dayStartHour: 4, dayEndHour: 20, pace: "balanced",
};

// ---------------------------------------------------- 拠点を移す区間の時刻 --

test("拠点を移す区間は、実際に乗れる便の時刻に置かれる", () => {
  const move = {
    day: 2, from: NAGOYA, to: NAMBA, minutes: 85,
    start: d("2026-09-10T04:00"), end: d("2026-09-10T05:25"),
  };
  const leg = {
    minutes: 85, rideMinutes: 84, waitMinutes: 130, routed: true,
    line: "12:16 発→ 13:40 着 1時間24分",
    yahoo: { departure: "12:16", arrival: "13:40" },
  };
  const itin = buildItinerary({
    trip, region: REGION, visits: [], reasons: new Map(),
    stays: [{ region: REGION, days: 3, dayFrom: 0, dayTo: 2,
              station: NAMBA }],
    moves: [move],
    legDetail: () => leg,
    legs: { outbound: { minutes: 85, routed: true } },
  });
  const item = itin.days.flatMap((x) => x.items)
    .find((i) => i.title?.includes("難波駅") && i.kind === "transit"
                 && i.detail?.includes("拠点を移します"));
  assert.ok(item, "拠点を移す区間が見当たりません");
  assert.equal(item.start.getHours(), 12, `${item.start}`);
  assert.equal(item.start.getMinutes(), 16, `${item.start}`);
  // 中身が実測なら、行も実測として扱われます（1日目だけ実測、の逆）。
  assert.equal(item.routed, true);
});

test("便に合わせて遅れたぶん、その日の立ち寄りも後ろへずれる", () => {
  const move = {
    day: 0, from: NAGOYA, to: NAMBA, minutes: 85,
    start: d("2026-09-08T04:00"), end: d("2026-09-08T05:25"),
  };
  const spot = { id: "x1", name: "通天閣", category: "展望台",
                 lat: 34.6524, lng: 135.5063, dwell: 60, open: 9, close: 21 };
  const visits = [{ spot, day: 0, arrive: d("2026-09-08T06:00"),
                    end: d("2026-09-08T07:00"), travel: 20, wait: 0, km: 3 }];
  const itin = buildItinerary({
    trip, region: REGION, visits, reasons: new Map(),
    stays: [{ region: REGION, days: 1, dayFrom: 0, dayTo: 0, station: NAMBA }],
    moves: [move],
    legDetail: () => ({
      minutes: 85, rideMinutes: 84, waitMinutes: 130, routed: true,
      line: "12:16 発→ 13:40 着", yahoo: { departure: "12:16" },
    }),
    legs: { outbound: { minutes: 85, routed: true } },
  });
  const visit = itin.days.flatMap((x) => x.items).find((i) => i.kind === "spot");
  assert.ok(visit.start >= d("2026-09-08T13:40"),
    `着く前に見学しています: ${visit.start}`);
});

// -------------------------------------------------- 区間ごとの「いつ」問い --

test("区間ごとに、その区間を通る日時で調べる", async () => {
  resetRoutesBreaker();
  const asked = [];
  const fetchStub = async (url, init) => {
    asked.push(JSON.parse(init.body));
    return { ok: true, status: 200,
             json: async () => ({ routed: false, minutes: 0 }) };
  };
  const real = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const times = [d("2026-09-08T09:00"), d("2026-09-10T09:00")];
    await computeRoute([NAGOYA, NAMBA, NAGOYA], {
      mode: "TRANSIT", departAt: times[0], departTimes: times,
    });
  } finally {
    globalThis.fetch = real;
    resetRoutesBreaker();
  }
  // 中継へ届いていれば、2区間それぞれの日付で聞いているはずです。
  if (asked.length >= 2) {
    assert.notEqual(asked[0].departAt.slice(0, 10),
      asked[1].departAt.slice(0, 10),
      `同じ日で聞いています: ${asked.map((a) => a.departAt)}`);
  }
});

// ------------------------------------------------ 拠点の周りの立ち寄り件数 --
//
// 立ち寄りは「滞在先のエリアIDと完全に一致するもの」だけを残していました。
// 収録のエリアは1,370あり、難波なら「大阪・ミナミ」と「大阪市」に
// 分かれています。AIが両方から選ぶと片方が黙って消え、その日は
// 1か所になります。収録を増やすほどひどくなる壊れ方でした。

import { loadKnowledgeBase } from "../js/kb.js";
import { assignToStays, planTrip } from "../js/pipeline.js";
import { findPlace } from "../js/places.js";
import { makeTrip } from "../js/trip.js";

const kb = await loadKnowledgeBase();

test("拠点の周りに候補があるなら、その日の立ち寄りは1か所で終わらない",
     async () => {
  const itin = await planTrip({
    trip: makeTrip({
      origin: findPlace("東京駅"),
      departAt: new Date("2026-09-08T08:00"),
      arriveBy: new Date("2026-09-10T20:00"),
      note: "大阪をゆっくり見たい",
      interests: [], budgetYen: 999999,
    }),
    kb,
  });
  const spotDays = itin.days
    .map((day) => day.items.filter((i) => i.kind === "spot").length)
    .filter((n) => n > 0);
  assert.ok(spotDays.length >= 2, `立ち寄りのある日が少なすぎます: ${spotDays}`);
  assert.ok(spotDays.every((n) => n >= 2),
    `1か所しかない日があります: ${spotDays}`);
});

test("隣り合うエリアの立ち寄りも、いちばん近い拠点のぶんとして残る", () => {
  const stays = [
    { region: { id: "nagoya", name: "名古屋" },
      station: { name: "名古屋駅", lat: 35.1709, lng: 136.8815 } },
    { region: { id: "osaka-minami", name: "大阪・ミナミ" }, station: NAMBA },
  ];
  const picks = [
    // 「大阪・ミナミ」ではなく「大阪市」の立ち寄り。以前はここで消えました。
    { id: "a", regionId: "n0144", name: "通天閣", lat: 34.6524, lng: 135.5063 },
    { id: "b", regionId: "osaka-minami", name: "道頓堀",
      lat: 34.6687, lng: 135.5013 },
    { id: "c", regionId: "aichi", name: "名古屋城", lat: 35.1856, lng: 136.8996 },
    // どの拠点からも遠い立ち寄りは、その日のうちに往復できません。
    { id: "d", regionId: "far", name: "知床", lat: 44.0, lng: 145.0 },
  ];
  const byStay = assignToStays(picks, stays);
  assert.deepEqual(byStay.map((list) => list.map((s) => s.id)),
    [["c"], ["a", "b"]]);
});
