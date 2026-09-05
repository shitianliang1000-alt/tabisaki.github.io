// 海外・特殊な要件を通す経路のテスト。
//
// 「パリで美術館をめぐりたい」は、収録が無いうえに検証が日本前提だったため
// 「見つかりません」で止まっていました。ここで確かめるのは、
//
//   1. 行き先を割り出せること（地名でも、地名でない希望でも）
//   2. 調べた結果を、日本と同じ厳しさで検証すること
//   3. 旅程として成立し、時差や査証など扱えないことを明示すること
//
// モデルは呼ばず、応答を差し替えて経路だけを通します。

import assert from "node:assert/strict";
import test from "node:test";

import { discoverArea, resolveDestination } from "../js/discover.js";
import { loadKnowledgeBase } from "../js/kb.js";
import { planTrip } from "../js/pipeline.js";
import { findPlace } from "../js/places.js";
import { makeTrip } from "../js/trip.js";

const RESOLVED_PARIS = {
  intent: "パリの美術館めぐり",
  places: [{ name: "パリ", country: "フランス", kind: "city",
             lat: 48.8566, lng: 2.3522, note: "セーヌ川沿いの首都" }],
};

const PARIS_AREAS = {
  areas: [{
    id: "paris-center", name: "パリ中心部", country: "フランス", prefecture: "",
    lat: 48.8566, lng: 2.3522,
    station: "シャトレ＝レ・アル", stationLat: 48.8620, stationLng: 2.3470,
    tagline: "美術館と大通りの街", description: "旧市街の中心。",
    spots: [
      { name: "ルーヴル美術館", category: "美術館", lat: 48.8606, lng: 2.3376,
        dwell: 180, open: 9, close: 18, fee: 3000, fame: "major", description: "" },
      { name: "オルセー美術館", category: "美術館", lat: 48.8600, lng: 2.3266,
        dwell: 150, open: 9.5, close: 18, fee: 2400, fame: "major", description: "" },
      { name: "ロダン美術館", category: "美術館", lat: 48.8553, lng: 2.3158,
        dwell: 60, open: 10, close: 18.5, fee: 2200, fame: "hidden", description: "" },
      { name: "オランジュリー美術館", category: "美術館", lat: 48.8638, lng: 2.3226,
        dwell: 70, open: 9, close: 18, fee: 1800, fame: "known", description: "" },
    ],
  }],
};

/** モデルの応答を、呼ばれたプロンプトに応じて返す差し替え。 */
function stubCall(map) {
  return async (prompt) => {
    for (const [needle, doc] of map) {
      if (prompt.includes(needle)) return JSON.stringify(doc);
    }
    throw new Error(`想定外のプロンプト: ${prompt.slice(0, 40)}`);
  };
}

const call = stubCall([
  ["どこへ行きたいのか", RESOLVED_PARIS],
  ["観光地を調べて", PARIS_AREAS],
]);

const overseasTrip = (note = "パリで美術館をめぐりたい") => makeTrip({
  origin: findPlace("東京駅"), budgetYen: 999999, note,
  departAt: new Date("2026-10-01T09:00"),
  arriveBy: new Date("2026-10-06T20:00"),
});

/** 実装をそのまま使い、モデル呼び出しだけ差し替えます。 */
const wired = {
  resolve: (text, o) => resolveDestination(text, { ...o, call }),
  discover: (term, o) => discoverArea(term, { ...o, call, useCache: false }),
};

test("希望文から海外の行き先を割り出せる", async () => {
  const r = await resolveDestination("パリで美術館をめぐりたい", { call });
  assert.equal(r.ok, true);
  assert.equal(r.places[0].name, "パリ");
  assert.equal(r.places[0].country, "フランス");
  assert.equal(r.places[0].verifiedPlace, true);
});

test("割り出しの段階でも、国と座標の矛盾は弾く", async () => {
  const liar = stubCall([["どこへ行きたいのか", {
    places: [{ name: "パリ", country: "日本", lat: 48.8566, lng: 2.3522 }],
  }]]);
  const r = await resolveDestination("パリに行きたい", { call: liar });
  assert.equal(r.ok, false, "日本と名乗るパリの座標が通っています");
});

test("海外の旅程が組める（これまでは「見つかりません」で止まっていた）", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: overseasTrip(), ...wired });
  assert.equal(itin.prefecture, "フランス", `選ばれたのは ${itin.regionName}`);
  const names = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot").map((i) => i.title);
  assert.ok(names.includes("ルーヴル美術館"), `立ち寄り: ${names.join("、")}`);
});

test("海外では、旅程エンジンで扱えないことを明示する", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: overseasTrip(), ...wired });
  const said = itin.warnings.join("\n");
  assert.match(said, /パスポート/);
  assert.match(said, /為替/);
  assert.match(said, /時計|時差/);
  assert.equal(itin.overseas?.country, "フランス");
});

test("現地に着く前の夜には、宿を取らない（機内泊）", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: overseasTrip(), ...wired });
  const items = itin.days.flatMap((d) => d.items);
  const lodgings = items.filter((i) => i.kind === "lodging");
  const inTransit = items.filter((i) => i.title === "移動中");
  assert.ok(inTransit.length >= 1, "機内泊が入っていません");
  // 出発日（1日目）に宿は入らない
  assert.ok(!itin.days[0].items.some((i) => i.kind === "lodging"),
    "まだ着いていない夜に宿が入っています");
  assert.ok(lodgings.length >= 1);
});

test("帰りの便より後ろに予定がはみ出さない", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: overseasTrip(), ...wired });
  const last = itin.days.at(-1).items.at(-1);
  assert.equal(last.kind, "transit", `最後の予定が ${last.title} です`);
  const limit = new Date("2026-10-06T20:00");
  assert.ok(last.end <= limit,
    `帰着が ${last.end.toLocaleString("ja-JP")} で期限を過ぎています`);
});

test("交通費が、鉄道の式を伸ばした非現実な額にならない", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: overseasTrip(), ...wired });
  const transit = itin.cost.rows.find((r) => r.key === "transit");
  // 東京〜パリの往復。空路の相場（往復15〜25万円）から大きく外れないこと
  assert.ok(transit.yen > 80000 && transit.yen < 300000,
    `交通費 ¥${transit.yen.toLocaleString()}`);
});

test("調べたときの出典を持ち帰る", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: overseasTrip(), ...wired });
  assert.ok(Array.isArray(itin.sources));
});

test("地名が書かれていない希望でも、行き先を割り出して調べる", async () => {
  const aurora = stubCall([
    ["どこへ行きたいのか", { intent: "オーロラ観測",
      places: [{ name: "トロムソ", country: "ノルウェー", kind: "city",
                 lat: 69.6492, lng: 18.9553 }] }],
    ["観光地を調べて", { areas: [{
      id: "tromso", name: "トロムソ", country: "ノルウェー", prefecture: "",
      lat: 69.6492, lng: 18.9553, station: "トロムソ中心部",
      stationLat: 69.6500, stationLng: 18.9560,
      spots: [
        { name: "オーロラ観測ツアー", category: "観光名所",
          lat: 69.66, lng: 18.96, dwell: 240, open: 18, close: 24,
          fee: 18000, fame: "major", description: "" },
        { name: "北極教会", category: "教会", lat: 69.6520, lng: 18.9880,
          dwell: 40, open: 9, close: 19, fee: 900, fame: "known", description: "" },
        { name: "フィエルヘイセン展望台", category: "展望台",
          lat: 69.6360, lng: 18.9830, dwell: 60, open: 10, close: 23,
          fee: 3200, fame: "known", description: "" },
      ] }] }],
  ]);
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({
    kb,
    trip: makeTrip({
      origin: findPlace("東京駅"), budgetYen: 999999, note: "オーロラが見たい",
      departAt: new Date("2026-12-01T09:00"),
      arriveBy: new Date("2026-12-07T20:00"),
    }),
    resolve: (t, o) => resolveDestination(t, { ...o, call: aurora }),
    discover: (t, o) => discoverArea(t, { ...o, call: aurora, useCache: false }),
  });
  assert.equal(itin.prefecture, "ノルウェー", `選ばれたのは ${itin.regionName}`);
});

// --- 地方名が当たっても、名指しの場所は調べる -------------------------------
//
// 「北海道の…宗谷岬、知床、青い池を巡りたい」で、北海道が当たった時点で
// 打ち切られ、宗谷岬は「収録がありません」で終わっていました。
// 当たったのは地方名で、名指しされた場所は何ひとつ調べていません。

const HOKKAIDO_NOTE = "北海道の有名な観光地を周遊したい。"
  + "宗谷岬、知床、青い池をめぐりたい。";

const HOKKAIDO_RESOLVED = {
  intent: "北海道の名所めぐり",
  places: [
    { name: "宗谷岬", country: "日本", kind: "spot", lat: 45.5228, lng: 141.9368 },
    { name: "知床", country: "日本", kind: "region", lat: 44.0700, lng: 145.0000 },
    { name: "青い池", country: "日本", kind: "spot", lat: 43.4922, lng: 142.6300 },
  ],
};

function hokkaidoArea(id, name, lat, lng, spots) {
  return { areas: [{
    id, name, country: "日本", prefecture: "北海道", lat, lng,
    station: `${name}周辺`, stationLat: lat, stationLng: lng,
    tagline: "", description: "",
    spots: spots.map(([n, cat, dlat, dlng]) => ({
      name: n, category: cat, lat: dlat, lng: dlng,
      dwell: 60, open: 0, close: 24, fee: 0, fame: "major", description: "",
    })),
  }] };
}

const HOKKAIDO_CALL = stubCall([
  ["どこへ行きたいのか", HOKKAIDO_RESOLVED],
  ["「宗谷岬」", hokkaidoArea("souya", "宗谷岬", 45.5228, 141.9368, [
    ["宗谷岬", "海岸", 45.5228, 141.9368],
    ["宗谷丘陵", "丘", 45.4900, 141.9200],
    ["稚内公園", "公園", 45.4150, 141.6700]])],
  ["「知床」", hokkaidoArea("shiretoko", "知床", 44.0700, 145.0000, [
    ["知床五湖", "湖", 44.1200, 145.0900],
    ["オシンコシンの滝", "滝", 44.0500, 144.9000],
    ["知床峠", "峠", 44.0300, 145.0500]])],
  ["「青い池」", hokkaidoArea("biei", "美瑛・青い池", 43.4922, 142.6300, [
    ["青い池", "湖", 43.4922, 142.6300],
    ["白ひげの滝", "滝", 43.5300, 142.6600],
    ["四季彩の丘", "丘", 43.5600, 142.4700]])],
]);

const hokkaidoWired = {
  resolve: (t, o) => resolveDestination(t, { ...o, call: HOKKAIDO_CALL }),
  discover: (t, o) => discoverArea(t, { ...o, call: HOKKAIDO_CALL, useCache: false }),
};

const hokkaidoTrip = () => makeTrip({
  origin: findPlace("札幌駅") ?? findPlace("東京駅"), budgetYen: 999999,
  note: HOKKAIDO_NOTE,
  departAt: new Date("2026-09-01T09:00"),
  arriveBy: new Date("2026-09-06T19:00"),
});

test("地方名が収録に当たっても、名指しされた場所を調べにいく", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: hokkaidoTrip(), ...hokkaidoWired });
  const said = itin.warnings.join("\n");
  assert.ok(!/宗谷岬.*収録がありません/.test(said),
    `調べずに「収録がありません」と言っています:\n${said}`);
  assert.match(said, /AIが検索して調べた/);
});

test("名指しされた場所が、実際に旅程へ入る", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: hokkaidoTrip(), ...hokkaidoWired });
  const names = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot").map((i) => i.title);
  const wanted = ["宗谷岬", "知床五湖", "青い池"];
  const hit = wanted.filter((w) => names.some((n) => n.includes(w)));
  assert.ok(hit.length >= 2,
    `名指しの場所が入っていません。立ち寄り: ${names.join("、")}`);
});

test("札幌・函館だけを選んで終わりにしない", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: hokkaidoTrip(), ...hokkaidoWired });
  assert.notEqual(itin.regionName, "札幌・函館",
    "名指しを無視して収録済みのエリアだけで組んでいます");
});
