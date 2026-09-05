// 組み立てた旅程が、実際に実行できる形になっているかのテスト。
// 検証は verify.js が済ませている前提なので、ここでは並びと欠落を見ます。

import assert from "node:assert/strict";
import test from "node:test";

import { buildItinerary } from "../js/planner.js";
import { verifyOrder } from "../js/verify.js";
import { END_MODES, makeTrip } from "../js/trip.js";
import { mixTargets, balanceByTier } from "../js/mix.js";
import { linksForItem, restaurantsUrl, hotelsUrl } from "../js/links.js";
import { fittableSpots, rankRegions } from "../js/kb.js";

const d = (s) => new Date(s);
const TOKYO = { name: "東京駅", lat: 35.681236, lng: 139.767125 };
const OSAKA = { name: "大阪駅", lat: 34.702485, lng: 135.495951 };

const REGION = {
  id: "r1", name: "テスト郷", prefecture: "神奈川県",
  station: "テスト駅", stationLat: 35.3190, stationLng: 139.5500,
  lat: 35.32, lng: 139.55, genres: ["history", "onsen"],
};

const spots = [
  { id: "s1", name: "神社A", category: "神社", lat: 35.3200, lng: 139.5520,
    description: "説明1。", fame_tier: "major" },
  { id: "s2", name: "寺B", category: "寺院", lat: 35.3210, lng: 139.5535,
    description: "説明2。", fame_tier: "known" },
  { id: "s3", name: "庭園C", category: "庭園", lat: 35.3220, lng: 139.5545,
    description: "説明3。", fame_tier: "hidden" },
];

function plan(over = {}) {
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-12T19:00"),
    ...over,
  });
  const startAt = d("2026-09-12T10:00");   // 駅到着後
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt,
    end: over.endPlaceOverride ?? TOKYO,
    endBy: trip.arriveBy,
  });
  return {
    trip, verification: v,
    itin: buildItinerary({
      trip, region: REGION, visits: v.visits,
      reasons: new Map(spots.map((s) => [s.id, `${s.name}を選んだ理由`])),
      legs: { outbound: { minutes: 60, routed: false },
              inbound: { minutes: 60, routed: false } },
    }),
  };
}

test("旅程は往路で始まり、復路で終わる", () => {
  const { itin } = plan();
  const items = itin.days.flatMap((x) => x.items);
  assert.equal(items[0].kind, "transit");
  assert.equal(items.at(-1).kind, "transit");
  assert.ok(items[0].title.includes("東京駅"));
});

test("項目が時系列に並び、重ならない", () => {
  const { itin } = plan();
  for (const day of itin.days) {
    let prev = null;
    for (const item of day.items) {
      assert.ok(item.end >= item.start, `${item.title} の終了が開始より前`);
      if (prev) {
        assert.ok(item.start >= prev,
          `${item.title} が前の項目より前に始まっている`);
      }
      prev = item.end;
    }
  }
});

test("復路は帰着期限までに到着する", () => {
  const { trip, itin } = plan();
  const last = itin.days.flatMap((x) => x.items).at(-1);
  assert.ok(last.end <= trip.arriveBy,
    `帰着 ${last.end.toISOString()} が期限を超えている`);
});

test("同じスポットが二度出てこない", () => {
  const { itin } = plan();
  const ids = itin.days.flatMap((x) => x.items)
    .filter((i) => i.kind === "spot").map((i) => i.spotId);
  assert.equal(ids.length, new Set(ids).size);
});

test("費用の合計が各項目の合計と一致する", () => {
  const { itin } = plan();
  const sum = itin.days.flatMap((x) => x.items)
    .reduce((a, i) => a + (i.costYen ?? 0), 0);
  assert.equal(itin.totalCostYen, sum);
});

test("最終目的地で終わる旅では、出発地に戻らない", () => {
  const { itin } = plan({
    endMode: END_MODES.END_AT_DESTINATION,
    destination: OSAKA,
    arriveBy: d("2026-09-12T22:00"),
    endPlaceOverride: OSAKA,
  });
  const last = itin.days.flatMap((x) => x.items).at(-1);
  assert.ok(last.title.includes("大阪駅"), last.title);
  assert.ok(last.title.includes("最終目的地"), last.title);
});

test("推定移動時間のときは、その旨が警告に出る", () => {
  const { itin } = plan();
  assert.ok(itin.warnings.some((w) => w.includes("推定")), itin.warnings.join(" / "));
});

test("スポットに選定理由が引き継がれる", () => {
  const { itin } = plan();
  const spot = itin.days.flatMap((x) => x.items).find((i) => i.kind === "spot");
  assert.ok(spot.reason.includes("選んだ理由"), spot.reason);
});

test("実データを持つスポットは「目安」警告の対象にならない", () => {
  const withReal = spots.map((s) => ({ ...s, open: 9, close: 18, fee: 500, dwell: 40 }));
  const v = verifyOrder(withReal, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"),
    end: TOKYO, endBy: d("2026-09-12T19:00"),
  });
  const itin = buildItinerary({
    trip: makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                     arriveBy: d("2026-09-12T19:00") }),
    region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: true },
            inbound: { minutes: 60, routed: true } },
  });
  assert.ok(!itin.warnings.some((w) => w.includes("目安です")),
    itin.warnings.join(" / "));
});

// ------------------------------------------------------------- 外部リンク --

test("食事の項目からレストラン検索が開ける", () => {
  const links = linksForItem(
    { kind: "meal", title: "昼食" },
    { lat: 35.32, lng: 139.55, regionName: "テスト郷" });
  assert.equal(links.length, 1);
  assert.ok(links[0].url.includes("google.com/maps"), links[0].url);
  assert.ok(decodeURIComponent(links[0].url).includes("レストラン"));
});

test("夕食は夕食向けのラベルになる", () => {
  const links = linksForItem(
    { kind: "meal", title: "夕食" },
    { lat: 35.32, lng: 139.55, regionName: "テスト郷" });
  assert.ok(links[0].label.includes("ディナー"), links[0].label);
});

test("宿泊の項目からホテル検索が、日付付きで開ける", () => {
  const links = linksForItem(
    { kind: "lodging", title: "宿泊" },
    { lat: 35.32, lng: 139.55, regionName: "テスト郷",
      checkIn: d("2026-09-12T19:00"), checkOut: d("2026-09-13T10:00") });
  assert.equal(links.length, 1);
  const url = links[0].url;
  assert.ok(url.includes("google.com/travel"), url);
  assert.ok(url.includes("checkin=2026-09-12"), url);
  assert.ok(url.includes("checkout=2026-09-13"), url);
});

test("スポットからは地図とWikipediaが開ける", () => {
  const links = linksForItem(
    { kind: "spot" },
    { place: { lat: 35.32, lng: 139.55, name: "神社A" }, wikipedia: "神社A" });
  const labels = links.map((l) => l.label);
  assert.ok(labels.some((l) => l.includes("地図")));
  assert.ok(labels.some((l) => l.includes("Wikipedia")));
  assert.ok(labels.some((l) => l.includes("OpenStreetMap")));
});

test("レストラン検索URLは座標を中心にする", () => {
  const url = restaurantsUrl({ lat: 35.32, lng: 139.55, regionName: "箱根" });
  assert.ok(url.includes("@35.32,139.55"), url);
});

test("ホテル検索は日付が無くても壊れない", () => {
  const url = hotelsUrl({ regionName: "箱根" });
  assert.ok(url.startsWith("https://www.google.com/travel/search"), url);
});

// --------------------------------------------------------- 定番と穴場 ---

test("穴場の枠は、定番寄り設定でも確保される", () => {
  for (let n = 3; n <= 12; n++) {
    assert.ok(mixTargets(n, 0).hidden >= 1, `n=${n}`);
  }
});

test("層の合計は必ず指定数に一致する", () => {
  for (let n = 0; n <= 20; n++) {
    for (const b of [0, 0.5, 1]) {
      const t = mixTargets(n, b);
      assert.equal(t.major + t.known + t.hidden, n, `n=${n} b=${b}`);
    }
  }
});

test("balanceByTier は各層から取る", () => {
  const matches = [
    ...Array.from({ length: 4 }, (_, i) => ({
      spot: { id: `M${i}`, fame_tier: "major" }, score: 1 })),
    ...Array.from({ length: 4 }, (_, i) => ({
      spot: { id: `K${i}`, fame_tier: "known" }, score: 1 })),
    ...Array.from({ length: 4 }, (_, i) => ({
      spot: { id: `H${i}`, fame_tier: "hidden" }, score: 1 })),
  ];
  const tiers = new Set(balanceByTier(matches, 6, 0.5).map((m) => m.spot.fame_tier));
  assert.ok(tiers.has("hidden"), "穴場が選ばれていない");
  assert.ok(tiers.has("major"), "定番が選ばれていない");
});

// --------------------------------------------- 旅先の順位付け（回帰） ---

test("強い一致1件より、良い一致3件の旅先が上位に来る", () => {
  // 平均で評価していたときは、1件だけ一致した町が勝っていました。
  const regions = [
    { id: "one", name: "一件だけ", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
    { id: "many", name: "三件ある", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
  ];
  const mk = (id, regionId) => ({ id, regionId, name: id, category: "自然",
    lat: 35.3, lng: 139.5, description: "" });
  const spots = [mk("o1", "one"), mk("m1", "many"), mk("m2", "many"), mk("m3", "many")];
  const spotsByRegion = new Map([
    ["one", [spots[0]]], ["many", spots.slice(1)],
  ]);
  const kb = { spots, regions, spotsByRegion,
               regionsById: new Map(regions.map((r) => [r.id, r])) };
  const matches = [
    { spot: spots[0], score: 1.0 },     // 一件だけ、満点
    { spot: spots[1], score: 0.95 },
    { spot: spots[2], score: 0.9 },
    { spot: spots[3], score: 0.85 },
  ];
  const ranked = rankRegions(kb, matches);
  assert.equal(ranked[0].region.id, "many",
    `一件だけの旅先が勝っている: ${ranked.map((r) => r.region.id)}`);
});

test("弱い一致を大量に持つ大都市が、数の力で勝つことはない", () => {
  const regions = [
    { id: "strong", name: "小さいが的確", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
    { id: "big", name: "大都市", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
  ];
  const mk = (id, regionId) => ({ id, regionId, name: id, category: "自然",
    lat: 35.3, lng: 139.5, description: "" });
  const spots = [mk("s1", "strong"), mk("s2", "strong")];
  for (let i = 0; i < 20; i++) spots.push(mk(`b${i}`, "big"));
  const spotsByRegion = new Map([
    ["strong", spots.slice(0, 2)], ["big", spots.slice(2)],
  ]);
  const kb = { spots, regions, spotsByRegion,
               regionsById: new Map(regions.map((r) => [r.id, r])) };
  const matches = [
    { spot: spots[0], score: 1.0 }, { spot: spots[1], score: 0.95 },
    ...spots.slice(2).map((s) => ({ spot: s, score: 0.2 })),
  ];
  const ranked = rankRegions(kb, matches);
  assert.equal(ranked[0].region.id, "strong",
    "弱い候補を大量に持つ大都市が勝っている");
});

test("希望したジャンルを持つ旅先が優先される", () => {
  const regions = [
    { id: "onsen-town", name: "温泉街", stationLat: 35.3, stationLng: 139.5,
      genres: ["onsen", "nature"], prefecture: "X" },
    { id: "mountain", name: "山", stationLat: 35.3, stationLng: 139.5,
      genres: ["nature"], prefecture: "X" },
  ];
  const mk = (id, regionId) => ({ id, regionId, name: id, category: "温泉",
    lat: 35.3, lng: 139.5, description: "" });
  const spots = [mk("a", "onsen-town"), mk("b", "mountain")];
  const kb = {
    spots, regions,
    spotsByRegion: new Map([["onsen-town", [spots[0]]], ["mountain", [spots[1]]]]),
    regionsById: new Map(regions.map((r) => [r.id, r])),
  };
  const matches = [
    { spot: spots[1], score: 1.0 },   // 山のほうがわずかに一致が強い
    { spot: spots[0], score: 0.95 },
  ];
  const plain = rankRegions(kb, matches);
  assert.equal(plain[0].region.id, "mountain", "前提: 素の一致では山が勝つ");

  const withGenre = rankRegions(kb, matches, 8, { wantedGenres: ["onsen"] });
  assert.equal(withGenre[0].region.id, "onsen-town",
    "温泉を希望しても温泉街が選ばれない");
});

// --- 公共交通の中身を旅程に載せる -------------------------------------------

test("往路に、路線・乗車駅・乗換・待ち時間を載せる", () => {
  const detail = {
    minutes: 60, routed: true, line: "JR東海道線",
    transit: {
      headline: "乗換1回・待ち8分・徒歩9分", transfers: 1,
      waitMinutes: 8, walkMinutes: 9, rideMinutes: 43,
      boardAt: "東京駅", alightAt: "テスト駅",
      segments: [{ kind: "ride", line: "JR東海道線", from: "東京駅",
                   to: "テスト駅", minutes: 43, stops: 6 }],
    },
  };
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: detail, inbound: { minutes: 60, routed: false } },
  });
  const out = itin.days[0].items.find((i) => i.kind === "transit");
  assert.ok(out.transit, "往路に公共交通の中身が載っていません");
  assert.equal(out.transit.boardAt, "東京駅");
  assert.match(out.detail, /乗換1回/);
});

test("区間の中身が引ければ、スポット間の移動にも載せる", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  // 神社A → 寺B の区間だけ、中身が分かっているとする
  const legDetail = (a, b) =>
    (a?.id === "s1" && b?.id === "s2")
      ? { minutes: 6, routed: true, line: "路線バス",
          transit: { headline: "乗換なし・待ち4分", transfers: 0,
                     waitMinutes: 4, boardAt: "神社前", alightAt: "寺入口",
                     segments: [] } }
      : null;
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(), legDetail,
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const withTransit = itin.days[0].items
    .filter((i) => i.kind === "transit" && i.transit);
  assert.ok(withTransit.some((i) => i.transit.boardAt === "神社前"),
    "スポット間の移動に公共交通の中身が載っていません");
});

test("中身が分からない移動には、何も足さない（推定を装わない）", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  for (const i of itin.days[0].items) {
    if (i.kind === "transit") assert.equal(i.transit, undefined);
  }
});

// --- 営業時間を旅程に載せる -------------------------------------------------

test("スポットに、その日の営業時間と最終入場を載せる", () => {
  const castle = { id: "c1", name: "テスト城", category: "城",
                   lat: 35.3200, lng: 139.5520, description: "城です。",
                   hours: { open: 9, close: 17, lastEntry: 16.5 } };
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder([castle], {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const spotItem = itin.days[0].items.find((i) => i.kind === "spot");
  assert.match(spotItem.hoursText, /09:00/);
  assert.match(spotItem.hoursText, /最終入場 16:30/);
});

test("休みが多い曜日にあたるスポットは、注意として旅程に出す", () => {
  // 2026-09-07 は月曜。美術館は月曜休館が多い分類です。
  const museum = { id: "m1", name: "テスト美術館", category: "美術館",
                   lat: 35.3200, lng: 139.5520, description: "美術館です。" };
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-07T09:00"),
                          arriveBy: d("2026-09-07T19:00") });
  const v = verifyOrder([museum], {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-07T11:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 120, routed: false },
            inbound: { minutes: 120, routed: false } },
  });
  assert.ok(itin.hoursWarnings?.some((w) => /月曜/.test(w)),
    `注意が出ていません: ${JSON.stringify(itin.hoursWarnings)}`);
});

test("自由時間が日をまたがない（23時間の「自由時間」を作らない）", () => {
  // 最終日の帰りまで間が空くと、そこに1つの大きな「自由時間」を
  // 置いていました。日をまたぐと 23時間41分 の自由時間になり、
  // 「いちばん長い1日は 29時間」という表示にもつながっていました。
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-14T19:00"),
  });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
    nights: 2, day0: trip.departAt,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, meals: v.meals, moves: v.moves,
    reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  for (const day of itin.days) {
    for (const item of day.items) {
      if (item.kind !== "free") continue;
      const minutes = (item.end - item.start) / 60000;
      assert.ok(minutes <= 8 * 60,
        `${Math.round(minutes)}分の自由時間があります（${item.title}）`);
      assert.equal(item.start.getDate(), item.end.getDate(),
        "自由時間が日をまたいでいます");
    }
  }
});

test("その日の行動終了時刻を越える自由時間は作らない", () => {
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-13T22:00"),
  });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
    nights: 1, day0: trip.departAt,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, meals: v.meals, moves: v.moves,
    reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const frees = itin.days.flatMap((x) => x.items).filter((i) => i.kind === "free");
  for (const f of frees) {
    assert.ok(f.end.getHours() <= 21,
      `自由時間が ${f.end.getHours()}時 まで続いています`);
  }
});

// --- 「その日、何か所まわれるか」を順位に効かせる ---------------------------
// 往復5時間の旅先は、行けはしても2〜3か所で終わります。時間の使いかたを
// 点にしないと、「せっかく行ったのに、ほとんど回れなかった」が起きます。

test("回れる件数は、移動を引いた残り時間から出す", () => {
  assert.equal(fittableSpots(60, 600), 5, "往復2時間・10時間なら5か所");
  assert.equal(fittableSpots(240, 600), 1, "往復8時間なら1か所");
  assert.equal(fittableSpots(320, 600), 0, "往復で使い切ったら0");
  assert.equal(fittableSpots(60, 30), 0, "そもそも足りない場合も0");
});

test("日帰りでは、遠くて数か所しか回れない旅先を上位にしない", () => {
  const regions = [
    { id: "near", name: "近い町", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
    { id: "far", name: "遠い町", stationLat: 37.0, stationLng: 140.0,
      genres: [], prefecture: "Y" },
  ];
  const mk = (id, regionId) => ({ id, regionId, name: id, category: "自然",
    lat: 35.3, lng: 139.5, description: "", fame_score: 50 });
  const spots = ["n1", "n2", "n3", "n4", "n5"].map((n) => mk(n, "near"))
    .concat(["f1", "f2", "f3", "f4", "f5"].map((n) => mk(n, "far")));
  const kb = {
    spots, regions,
    spotsByRegion: new Map([["near", spots.slice(0, 5)], ["far", spots.slice(5)]]),
    regionsById: new Map(regions.map((r) => [r.id, r])),
  };
  // 遠いほうが、場所そのものの一致はわずかに強い。
  const matches = [
    ...spots.slice(5).map((s) => ({ spot: s, score: 0.92 })),
    ...spots.slice(0, 5).map((s) => ({ spot: s, score: 0.88 })),
  ];
  const opts = { oneWayByRegion: new Map([["near", 60], ["far", 250]]),
                 totalMinutes: 600 };

  const day = rankRegions(kb, matches, 8, { ...opts, days: 1 });
  assert.equal(day[0].region.id, "near",
    "日帰りなのに、往復8時間ちかい旅先が上位に来ています");

  // 泊まりなら話は別です。初日にかけた移動は、翌日以降で取り返せます。
  // 順位まで入れ替わるとは限らないので、遠さの不利が縮むことを見ます。
  const gapOf = (ranked) => {
    const by = new Map(ranked.map((c) => [c.region.id, c.score]));
    return by.get("near") - by.get("far");
  };
  const stay = rankRegions(kb, matches, 8, { ...opts, days: 3 });
  assert.ok(gapOf(stay) < gapOf(day),
    `泊まりでも移動を同じだけ嫌っています（日帰り ${gapOf(day).toFixed(2)} / `
    + `3日 ${gapOf(stay).toFixed(2)}）`);
});
