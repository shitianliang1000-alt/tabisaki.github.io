// 名前のある旅のしかた（最長往復切符・国道1号線の旅）を、行き先ではなく
// 旅の形として読む。
//
// 「国道1号線の旅がしたい」は「国道」「号線」が検索語になり、
// 「『国道1号線』に該当する場所は見つかりませんでした」と出ていました。

import assert from "node:assert/strict";
import test from "node:test";

import { blockOf } from "../js/areas.js";
import { journeyNote, normalizeJourney, pickJourney, readJourney,
         stripJourney } from "../js/journeys.js";
import { loadKnowledgeBase } from "../js/kb.js";
import { planTrip } from "../js/pipeline.js";
import { findPlace } from "../js/places.js";
import { makeTrip } from "../js/trip.js";

const kb = await loadKnowledgeBase();

const trip = (note, extra = {}) => makeTrip({
  origin: findPlace("東京駅"), note, budgetYen: 999999,
  departAt: new Date("2026-09-01T07:00"),
  arriveBy: new Date("2026-09-05T21:00"), ...extra,
});

test("手元で分かる旅のしかたを読む", () => {
  const r1 = readJourney("国道1号線の旅がしたい");
  assert.equal(r1.name, "国道1号線");
  assert.equal(r1.transport, "car");
  assert.equal(r1.along[0], "東京");
  assert.equal(r1.along.at(-1), "大阪");
  assert.equal(readJourney("Ｒ２を走りたい").name, "国道2号線");

  const r2 = readJourney("最長往復切符で旅したい");
  assert.equal(r2.name, "最長往復切符");
  assert.equal(r2.transport, "transit");
  assert.equal(r2.spread, true);
  assert.equal(r2.enjoyTravel, true);
  assert.match(r2.meaning, /往復|戻る/);

  assert.equal(readJourney("温泉でのんびり"), null);
  assert.equal(readJourney("国道999号線"), null, "知らない番号は作りません");
});

test("AIの読み取りは形をそろえ、手元で分かるものを先にする", () => {
  const raw = { name: "只見線の旅", meaning: "福島と新潟を結ぶ只見線に乗る旅",
                transport: "rocket", enjoyTravel: true, along: ["会津若松", "只見", "小出", ""] };
  const j = normalizeJourney(raw);
  assert.equal(j.transport, null, "知らない乗り物は使いません");
  assert.deepEqual(j.along, ["会津若松", "只見", "小出"]);
  assert.equal(j.known, false);
  assert.match(journeyNote(j), /AIの読み取り/);
  assert.equal(normalizeJourney({ name: "" }), null);

  const picked = pickJourney("国道1号線の旅", { name: "国道1号線", along: ["札幌"] });
  assert.equal(picked.known, true);
  assert.equal(picked.along[0], "東京");
});

test("旅のしかたの名前を、地名として読まない", () => {
  assert.ok(!/東海/.test(stripJourney("東海道五十三次を歩きたい")));
  assert.ok(!/国道/.test(stripJourney("国道1号線で京都へ")));
  assert.match(stripJourney("国道1号線で京都へ"), /京都/);
});

test("国道1号線の旅は、車で道沿いの街を回り、国道を探さない", async () => {
  const itin = await planTrip({ kb, trip: trip("国道1号線の旅がしたい") });
  assert.equal(itin.transport, "car");
  const prefs = new Set(itin.regionIds
    .map((id) => kb.regionsById.get(id)?.prefecture));
  const along = ["東京都", "神奈川県", "静岡県", "愛知県", "三重県",
                 "滋賀県", "京都府", "大阪府"];
  assert.ok([...prefs].every((p) => along.includes(p)),
    `道沿いでない県: ${[...prefs].join("・")}`);
  assert.ok(!/国道|号線/.test(itin.coverage?.text ?? ""), itin.coverage?.text);
  assert.ok(itin.warnings.some((w) => /「国道1号線」は/.test(w)));
});

test("最長往復切符は、全国を地方ごとに回る", async () => {
  const itin = await planTrip({ kb, trip: trip("最長往復切符で旅したい") });
  assert.equal(itin.enjoyTravel, true);
  const blocks = new Set(itin.regionIds
    .map((id) => blockOf(kb.regionsById.get(id))));
  assert.ok(blocks.size >= 2, [...blocks].join("・"));
  assert.ok(itin.warnings.some((w) => /「最長往復切符」は/.test(w)));
});
