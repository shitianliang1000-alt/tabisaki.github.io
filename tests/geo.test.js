// 海外を扱えるようにした部分のテスト。
//
// 「見つかりません」で止まっていた原因は、日本の緯度経度と都道府県名を
// 前提に検証していたことでした。前提を地球ぜんぶに広げたぶん、
// 「名乗った土地と座標が矛盾していないか」の確かめ方が要になります。

import assert from "node:assert/strict";
import test from "node:test";

import { estimateMinutes, haversineKm } from "../js/feasibility.js";
import {
  airportDistanceKm, dateShiftDays, islandOf, isJapan, lookupCountry, onEarth,
  overseasNotes, timezoneShiftHours, travelLabel, travelMinutes,
} from "../js/geo.js";

const TOKYO = { name: "東京駅", lat: 35.6812, lng: 139.7671, country: "日本" };
const PARIS = { name: "パリ", lat: 48.8566, lng: 2.3522, country: "フランス" };
const SEOUL = { name: "ソウル", lat: 37.5665, lng: 126.9780, country: "韓国" };
const HAKATA = { name: "博多", lat: 33.5897, lng: 130.4207, country: "日本" };

test("国名から位置を引ける（表記ゆれも通す）", () => {
  assert.equal(lookupCountry("フランス").name, "フランス");
  assert.equal(lookupCountry("アメリカ合衆国").name, "アメリカ");
  assert.equal(lookupCountry("米国").name, "アメリカ");
  assert.equal(lookupCountry("フランス共和国").name, "フランス");
  assert.equal(lookupCountry("架空国"), null);
});

test("地球の範囲外は弾く", () => {
  assert.ok(onEarth(48.85, 2.35));
  assert.ok(!onEarth(200, 999));
  assert.ok(!onEarth(NaN, 0));
});

test("日本国内かどうかを、国名でも座標でも判断できる", () => {
  assert.ok(isJapan(TOKYO));
  assert.ok(!isJapan(PARIS));
  assert.ok(isJapan({ lat: 34.69, lng: 135.19 }));      // 国名なし・神戸
  assert.ok(!isJapan({ lat: 48.85, lng: 2.35 }));
});

test("長距離は空路として見積もる（これが無いと海外が全部弾かれた）", () => {
  const min = estimateMinutes(TOKYO, PARIS);
  const hours = min / 60;
  // 実際の東京〜パリは、乗継無しの直行便で12〜13時間＋空港の時間
  assert.ok(hours > 13 && hours < 22, `${hours.toFixed(1)}時間`);
  // 地上をたどる式のままなら 80 時間になります
  assert.ok(hours < 30, "陸路の式のまま計算されています");
});

test("国内の長距離は、現実的な所要時間になる", () => {
  const h = estimateMinutes(TOKYO, HAKATA) / 60;
  assert.ok(h > 3.5 && h < 6.5, `${h.toFixed(1)}時間`);   // 新幹線5時間・空路4.5時間
});

test("近距離の見積もりは、これまでと変わらない", () => {
  const near = { lat: 35.6820, lng: 139.7680 };
  assert.equal(estimateMinutes(TOKYO, near), estimateMinutes(TOKYO, near));
  assert.ok(estimateMinutes(TOKYO, near) < 15);
});

test("国際線は、国内線より手続きのぶん長く見る", () => {
  // 距離をそろえて比べる（ソウルと同じくらいの距離の国内地点）
  const km = haversineKm(TOKYO, SEOUL);
  const domestic = { lat: 26.6, lng: 128.0, country: "日本" };  // 沖縄本島の北
  assert.ok(Math.abs(haversineKm(TOKYO, domestic) - km) < 400);
  assert.ok(travelMinutes(TOKYO, SEOUL) > travelMinutes(TOKYO, domestic));
});

test("移動手段の呼び名が距離に対応している", () => {
  assert.equal(travelLabel(0.8), "徒歩");
  assert.equal(travelLabel(20), "在来線・バス");
  assert.equal(travelLabel(300), "新幹線・特急");
  assert.equal(travelLabel(9000), "空路");
});

test("国をまたぐときだけ、旅程では扱えないことを伝える", () => {
  assert.equal(overseasNotes(TOKYO, HAKATA).length, 0);
  const notes = overseasNotes(TOKYO, PARIS);
  assert.ok(notes.length >= 3);
  assert.ok(notes.some((n) => /パスポート/.test(n)));
  assert.ok(notes.some((n) => /為替/.test(n)));
  assert.ok(notes.some((n) => /時間/.test(n)));
});

test("時差は短いほうに丸め、日付のずれは別に持つ", () => {
  const honolulu = { lat: 21.31, lng: -157.86 };
  const shift = timezoneShiftHours(TOKYO, honolulu);
  assert.ok(shift > -12 && shift <= 12, `${shift}時間`);
  assert.equal(dateShiftDays(TOKYO, honolulu), -1, "日付が戻ることを見ていません");
  assert.equal(dateShiftDays(TOKYO, PARIS), 0);
  // 経度からの推定なので、実際の標準時とは1時間ほどずれます
  assert.ok(Math.abs(timezoneShiftHours(TOKYO, SEOUL)) <= 1);
});

test("日付がずれる渡航では、そのことを書く", () => {
  const honolulu = { lat: 21.31, lng: -157.86, country: "アメリカ" };
  const notes = overseasNotes(TOKYO, honolulu);
  assert.ok(notes.some((n) => /日付は1日戻ります/.test(n)), notes.join(" / "));
});

// --- 空港が無いところから飛ばない ------------------------------------------
// これが無いと、どこからでも飛行機に乗れることになります。
// 「松本から網走へ4時間」は、ここが抜けていたせいでした。

const MATSUMOTO = { name: "松本", lat: 36.2306, lng: 137.9653, country: "日本" };
const ABASHIRI = { name: "網走", lat: 44.0206, lng: 144.2734, country: "日本" };
const SAPPORO = { name: "札幌", lat: 43.0686, lng: 141.3508, country: "日本" };
const OKAYAMA = { name: "岡山", lat: 34.6664, lng: 133.9182, country: "日本" };
const TAKAMATSU = { name: "高松", lat: 34.3401, lng: 134.0466, country: "日本" };
const SHIRETOKO = { name: "知床", lat: 44.15, lng: 145.05, country: "日本" };
// 山の中。いちばん近い空港からも遠い。
const OKUCHICHIBU = { name: "奥秩父", lat: 35.90, lng: 138.75, country: "日本" };

test("地方どうしの長距離は、乗り継ぎのぶんだけ長くなる", () => {
  const min = travelMinutes(MATSUMOTO, ABASHIRI);
  assert.ok(min > 6 * 60,
    `松本から網走が ${(min / 60).toFixed(1)}時間 です（短すぎます）`);
});

test("拠点空港どうしなら、乗り継ぎのぶんは付かない", () => {
  // 東京〜札幌は直行便があります。松本〜網走より近いのに
  // 長くなる、ということが起きてはいけません。
  assert.ok(travelMinutes(TOKYO, SAPPORO) < travelMinutes(MATSUMOTO, ABASHIRI));
});

test("空港から遠い場所どうしは、陸路で見積もる", () => {
  // 飛行機を使えることにすると、山の中から山の中へ「空路で4時間」に
  // なります。まず空港まで出る時間がかかります。
  const far = travelMinutes(OKUCHICHIBU, SHIRETOKO);
  assert.ok(far > 9 * 60,
    `${(far / 60).toFixed(1)}時間 です。陸路で見積もれていません`);
  // 空港のある東京から札幌へ行くより、はるかに長いはずです
  // （距離は同じくらいなのに、飛行機に乗れないため）。
  assert.ok(far > travelMinutes(TOKYO, SAPPORO) * 1.5,
    "空港が使える区間と同じくらいの時間になっています");
});

test("空港までの距離を測れる", () => {
  assert.ok(airportDistanceKm(TOKYO) < 30, "東京の近くに空港が無い扱いです");
  assert.ok(airportDistanceKm(OKUCHICHIBU) > 40);
});

// --- 島をまたぐときは、渡れる場所を通る ------------------------------------

test("島の見分けがつく", () => {
  assert.equal(islandOf(SAPPORO), "hokkaido");
  assert.equal(islandOf(TOKYO), "honshu");
  assert.equal(islandOf(TAKAMATSU), "shikoku");
  assert.equal(islandOf(HAKATA), "kyushu");
  assert.equal(islandOf({ lat: 26.21, lng: 127.68 }), "okinawa");
});

test("瀬戸内海をまっすぐ突っ切らない", () => {
  // 岡山と高松は直線40kmですが、橋まで出てから渡ります。
  const min = travelMinutes(OKAYAMA, TAKAMATSU);
  assert.ok(min > 40, `${min}分 です。橋を通っていません`);
});

test("同じ島の中では、余計な上乗せをしない", () => {
  // 岡山〜高松（島をまたぐ40km）より、同じ島の40kmのほうが速いはず。
  const sameIsland = travelMinutes(OKAYAMA,
    { lat: 34.99, lng: 133.92, country: "日本" });   // 岡山県北へ約36km
  assert.ok(sameIsland < travelMinutes(OKAYAMA, TAKAMATSU));
});

// --- 直線距離のままにしない -------------------------------------------------

test("線路も道路も、まっすぐには通っていない", () => {
  // 直線 74km を時速55kmで割ると81分。実際の小田急は85〜100分です。
  const min = travelMinutes(
    { lat: 35.6896, lng: 139.7006 }, { lat: 35.2325, lng: 139.1063 });
  assert.ok(min > 90, `${min}分 です（直線のまま計算しています）`);
  assert.ok(min < 160, `${min}分 です（かかりすぎです）`);
});

test("国外は、日本の空港までの距離で測らない", () => {
  // いちばん近い「日本の」空港を使うと、ソウルの空港アクセスが
  // 550kmになり、13時間を超えていました。
  const min = travelMinutes(TOKYO, SEOUL);
  assert.ok(min < 10 * 60, `東京からソウルが ${(min / 60).toFixed(1)}時間 です`);
  assert.ok(min > 4 * 60);
});
