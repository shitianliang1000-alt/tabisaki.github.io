// 画面で実際に壊れていた入力を、そのまま流して固定する。
//
//   「四国の有名な観光地を巡りたい」／東京駅発／9泊10日
//     → 銚子（千葉県）が提案され、4スポット・所要225時間45分・
//       余裕12951分という結果になっていました。
//
// APIキーは未設定なので、AI無し（語句検索＋距離推定）の経路を通ります。
// ネットワークにも触りません。

import assert from "node:assert/strict";
import test from "node:test";

import { loadKnowledgeBase } from "../js/kb.js";
import { planTrip } from "../js/pipeline.js";
import { findPlace } from "../js/places.js";
import { makeTrip } from "../js/trip.js";
import { areaScope, detectAreas } from "../js/areas.js";

const kb = await loadKnowledgeBase();

function trip(over = {}) {
  return makeTrip({
    origin: findPlace("東京駅"),
    departAt: new Date("2026-08-31T09:00"),
    arriveBy: new Date("2026-09-09T19:00"),
    note: "四国の有名な観光地を巡りたい",
    interests: [],
    budgetYen: 999999,
    ...over,
  });
}

test("「四国」は地名として解釈され、四国4県の収録エリアに結びつく", () => {
  const scope = areaScope(detectAreas("四国の有名な観光地を巡りたい", kb));
  assert.ok(scope.regionIds, "地名で絞り込めていません");
  const prefs = new Set([...scope.regionIds]
    .map((id) => kb.regionsById.get(id).prefecture));
  assert.deepEqual([...prefs].sort(),
    ["愛媛県", "徳島県", "香川県", "高知県"].sort());
});

test("「四国」で銚子（千葉県）は提案されない", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  const prefs = itin.prefecture.split("・");
  for (const p of prefs) {
    assert.ok(["徳島県", "香川県", "愛媛県", "高知県"].includes(p),
      `四国以外が選ばれています: ${itin.regionName}（${itin.prefecture}）`);
  }
});

test("9泊10日なら、日数ぶんの旅程になる", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  assert.ok(itin.days.length >= 8,
    `10日間なのに${itin.days.length}日ぶんしかありません`);
  assert.ok(itin.spotCount >= 15,
    `10日間で${itin.spotCount}スポットは少なすぎます`);
});

test("夜通し観光する旅程にならない", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  for (const day of itin.days) {
    for (const item of day.items) {
      if (item.kind !== "spot") continue;
      const h = item.start.getHours();
      assert.ok(h >= 5 && h < 21,
        `${item.title} が ${item.start.toLocaleString("ja-JP")} に始まっています`);
    }
  }
});

test("宿泊は泊数ぶん入り、その日にいるエリアに取る", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  const lodgings = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "lodging");
  assert.equal(lodgings.length, 9, "9泊ぶんの宿泊が入っていません");
  const areas = new Set(lodgings.map((l) => l.near.regionName));
  assert.ok(areas.size >= 2, `10日間ずっと同じ宿です: ${[...areas]}`);
});

test("長い旅では拠点を移す", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  assert.ok(itin.stays.length >= 2,
    `10日間で1エリアに留まっています: ${itin.regionName}`);
});

test("日帰りは、これまでどおり1日で収まる", async () => {
  const itin = await planTrip({
    kb,
    trip: trip({
      note: "鎌倉で歴史ある街を歩きたい",
      departAt: new Date("2026-08-31T09:00"),
      arriveBy: new Date("2026-08-31T19:00"),
    }),
  });
  assert.equal(itin.days.length, 1);
  assert.ok(itin.spotCount >= 2);
  assert.equal(itin.days[0].items.filter((i) => i.kind === "lodging").length, 0);
});

test("収録の無い地名は、黙って別の場所に置き換えず、そう書く", async () => {
  const itin = await planTrip({
    kb,
    trip: trip({
      note: "屋久島の縄文杉を見たい",
      departAt: new Date("2026-08-31T09:00"),
      arriveBy: new Date("2026-09-02T19:00"),
    }),
  });
  const said = [itin.coverage?.text ?? "", ...itin.warnings].join("\n");
  assert.match(said, /屋久島|収録/);
});

// --- 収録に無い土地を、調べてから旅程にする ---------------------------------

const SAKYU = {
  ok: true, term: "鳥取砂丘", cached: false, rejected: [],
  regions: [{
    id: "tottori", name: "鳥取砂丘", prefecture: "鳥取県", prefectureId: "tottori",
    hub: "tokyo", lat: 35.5390, lng: 134.2260,
    station: "鳥取駅", stationLat: 35.4900, stationLng: 134.2310,
    genres: ["sea", "art", "history"], spotCount: 3,
    tagline: "日本海に面した砂の丘", description: "砂丘と、砂の美術館。",
    source: "ai", verified: false,
  }],
  spots: [
    { id: "tottori-1", regionId: "tottori", region: "鳥取砂丘", name: "鳥取砂丘",
      category: "海岸", genres: ["sea"], lat: 35.5390, lng: 134.2260,
      prefecture: "鳥取県", prefectureId: "tottori", description: "馬の背。",
      fame_score: 86, fame_tier: "major", dwell: 90, open: 0, close: 24, fee: 0,
      source: "ai", verified: false },
    { id: "tottori-2", regionId: "tottori", region: "鳥取砂丘", name: "砂の美術館",
      category: "美術館", genres: ["art"], lat: 35.5352, lng: 134.2266,
      prefecture: "鳥取県", prefectureId: "tottori", description: "砂の彫刻。",
      fame_score: 58, fame_tier: "known", dwell: 60, open: 9, close: 18, fee: 800,
      source: "ai", verified: false },
    { id: "tottori-3", regionId: "tottori", region: "鳥取砂丘", name: "白兎神社",
      category: "神社", genres: ["history"], lat: 35.4933, lng: 134.0994,
      prefecture: "鳥取県", prefectureId: "tottori", description: "因幡の白兎。",
      fame_score: 28, fame_tier: "hidden", dwell: 30, open: 0, close: 24, fee: 0,
      source: "ai", verified: false },
  ],
};

test("収録に無い土地でも、調べてその土地の旅程になる", async () => {
  const fresh = await loadKnowledgeBase();
  const itin = await planTrip({
    kb: fresh,
    discover: async () => SAKYU,
    trip: trip({
      note: "鳥取砂丘を見たい",
      departAt: new Date("2026-09-05T08:00"),
      arriveBy: new Date("2026-09-06T20:00"),
    }),
  });
  assert.equal(itin.prefecture, "鳥取県",
    `鳥取以外が選ばれています: ${itin.regionName}（${itin.prefecture}）`);
  const names = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot").map((i) => i.title);
  assert.ok(names.includes("鳥取砂丘"), `立ち寄り: ${names.join("、")}`);
});

test("調べたデータであることを、旅程に明記する", async () => {
  const fresh = await loadKnowledgeBase();
  const itin = await planTrip({
    kb: fresh,
    discover: async () => SAKYU,
    trip: trip({
      note: "鳥取砂丘を見たい",
      departAt: new Date("2026-09-05T08:00"),
      arriveBy: new Date("2026-09-06T20:00"),
    }),
  });
  const said = itin.warnings.join("\n");
  assert.match(said, /AIが検索して調べた/);
  assert.match(said, /未確認/);
});

test("調べられなかったときは、そう書く（黙って別の土地を出さない）", async () => {
  const fresh = await loadKnowledgeBase();
  const itin = await planTrip({
    kb: fresh,
    discover: async (term) => ({ ok: false, term, regions: [], spots: [],
                                 rejected: [], reason: "AIキーが未設定です" }),
    trip: trip({
      note: "屋久島の縄文杉を見たい",
      departAt: new Date("2026-09-05T09:00"),
      arriveBy: new Date("2026-09-07T19:00"),
    }),
  });
  assert.match(itin.warnings.join("\n"), /屋久島/);
});

test("利用者が選んだペースは、AIの読み取りに上書きされない", async () => {
  // 「もっとゆっくり」を押したのに、希望文からの推測でペースが
  // 戻されていました。押したのに何も変わらない、がいちばん困ります。
  const slow = await planTrip({
    trip: trip({ pace: "relaxed", note: "四国をきびきび回りたい" }), kb });
  const packed = await planTrip({
    trip: trip({ pace: "packed", note: "四国をきびきび回りたい" }), kb });
  assert.ok(slow.spotCount < packed.spotCount,
    `ゆっくり ${slow.spotCount}か所 / 詰めこみ ${packed.spotCount}か所 — `
    + "選んだペースが効いていません");
});

test("天気が取れれば、見直しの提案が旅程に付く", async () => {
  // 予報は注入します（この環境から Open-Meteo には出られません）。
  const rainy = (at, date) => Promise.resolve({
    ok: true, date: "x",
    rows: Array.from({ length: 24 }, (_, h) => ({
      iso: `2026-09-12T${String(h).padStart(2, "0")}:00`,
      rain: h >= 12 && h <= 16 ? 90 : 5, temp: 22, code: 61,
    })),
  });
  const itin = await planTrip({ trip: trip(), kb, forecast: rainy });
  assert.ok(itin.replan, "見直しの結果が付いていません");
  assert.ok(Array.isArray(itin.replan.suggestions));
  assert.ok(itin.replan.days.length > 0, "その日の天気の要約がありません");
});

test("天気が取れなくても、旅程はそのまま出る", async () => {
  const broken = () => Promise.reject(new Error("つながりません"));
  const itin = await planTrip({ trip: trip(), kb, forecast: broken });
  assert.ok(itin.days.length > 0, "天気の失敗で旅程が消えています");
  // 天気の提案は出ませんが、混雑や日没の提案は天気に依らず出ます
  assert.equal(itin.replan.suggestions.filter((s) => s.kind === "rain").length,
               0);
  assert.deepEqual(itin.replan.days, []);
});

test("天気を使わない指定ができる（軽量モード用）", async () => {
  let called = 0;
  const spy = () => { called++; return Promise.resolve({ ok: false }); };
  const itin = await planTrip({ trip: trip(), kb, forecast: spy,
                               useWeather: false });
  assert.equal(called, 0, "使わない指定なのに天気を取りに行っています");
  assert.deepEqual(itin.replan.suggestions, [],
    "使わない指定のときは、混雑や日没の提案も出しません");
});
