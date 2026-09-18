// 現在地から「着いた」に気づく。
//
// 旅行中モードの「着いた」ボタンは、押されないと何も始まりません。
// けれど当日、着いた瞬間は鳥居を見ていて、携帯の中のボタンのことは
// 忘れています。30分後に思い出して押すと、**30分の遅れとして数えられ
// ます**（着いた時刻を、押した時刻で代えているためです）。
//
// 端末は自分がどこにいるかを知っているので、聞けば済みます。
// ここで確かめたいのは、**言いすぎないこと**です。
//
//   ・誤差が大きいときは何も言わない（数えているふりをしない）
//   ・1回のずれた測定で言わない
//   ・言うだけで、旅程は変えない

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ACCURACY_M, STABLE_FIXES, arrivableItems, arrivedAt, pointOf,
  radiusFor, watchArrival,
} from "../js/arrive.js";

// 出雲大社（35.4020, 132.6857）とその周り。
const IZUMO = { lat: 35.4020, lng: 132.6857 };
const STATION = { lat: 35.3955, lng: 132.6906 };   // 出雲大社前駅（約800m）

const spot = (id, title, place) => ({ id, kind: "spot", title, place });

function itin(now = new Date("2026-09-19T11:00:00+09:00")) {
  return { days: [{ date: now, items: [
    { id: "t1", kind: "transit", title: "移動", to: { ...STATION, name: "駅" } },
    spot("s1", "出雲大社", { ...IZUMO, name: "出雲大社", category: "神社" }),
    { id: "f1", kind: "free", title: "自由時間" },
    spot("s2", "島根県立古代出雲歴史博物館",
      { lat: 35.4008, lng: 132.6894, name: "古代出雲歴史博物館",
        category: "博物館" }),
  ] }] };
}

// --- 半径 -------------------------------------------------------------------

test("分類ごとに、着いたとみなす広さが違う", () => {
  // 境内は広く、飲食店は狭い。同じ半径で見ると、神社では鳥居の前に
  // いても「まだです」になり、飲食店では隣の建物で「着きました」に
  // なります。
  const shrine = spot("a", "神社", { category: "神社" });
  const rest = spot("b", "食事処", { category: "飲食店" });
  const park = spot("c", "国立公園", { category: "国立公園" });
  assert.ok(radiusFor(shrine) > radiusFor(rest));
  assert.ok(radiusFor(park) > radiusFor(shrine));
});

test("端末の誤差ぶんだけ、広げる", () => {
  const s = spot("a", "神社", { category: "神社" });
  assert.equal(radiusFor(s, 100) - radiusFor(s, 0), 100);
  // 誤差が負や NaN でも壊れません。
  assert.equal(radiusFor(s, -50), radiusFor(s, 0));
  assert.equal(radiusFor(s, Number.NaN), radiusFor(s, 0));
});

test("知らない分類でも、半径は決まる", () => {
  assert.ok(radiusFor(spot("a", "謎", { category: "謎の分類" })) > 0);
  assert.ok(radiusFor(spot("a", "名無し", {})) > 0);
  assert.ok(radiusFor({ kind: "lodging" }) > 0);
});

// --- どの予定を見るか ---------------------------------------------------------

test("「着いた」と言えるのは、立ち寄り・食事・宿だけ", () => {
  // 移動に「着いた」はありません（「小町通りへ移動 に着いた」は
  // 日本語として通りません）。自由時間も場所ではありません。
  const ids = arrivableItems(itin(), new Date("2026-09-19T11:00:00+09:00"))
    .map((i) => i.id);
  assert.deepEqual(ids, ["s1", "s2"]);
});

test("座標の無い予定は、見ない", () => {
  const bad = { days: [{ date: new Date(), items: [
    spot("x", "どこか", { name: "座標なし" }),
    spot("y", "壊れた", { lat: "あ", lng: null }),
  ] }] };
  assert.equal(arrivableItems(bad, new Date()).length, 0);
  assert.equal(pointOf(spot("x", "", {})), null);
});

// --- 判定 -------------------------------------------------------------------

const NOW = new Date("2026-09-19T11:00:00+09:00");

test("近くにいれば、その予定を返す", () => {
  const got = arrivedAt({ ...IZUMO, accuracyM: 20 }, itin(), NOW);
  assert.equal(got.item.id, "s1");
  assert.ok(got.km < 0.05);
  assert.ok(got.radiusM > 0);
});

test("遠ければ、何も言わない", () => {
  // 駅（約800m）からは、神社の半径250m + 誤差20m に入りません。
  assert.equal(arrivedAt({ ...STATION, accuracyM: 20 }, itin(), NOW), null);
});

test("誤差が大きすぎるときは、何も言わない", () => {
  // 誤差800mの測定で「250m以内なので着きました」と言うのは、
  // 数えているふりです。
  assert.equal(
    arrivedAt({ ...IZUMO, accuracyM: MAX_ACCURACY_M + 1 }, itin(), NOW), null);
  // 境目までは言います。
  assert.ok(arrivedAt({ ...IZUMO, accuracyM: MAX_ACCURACY_M }, itin(), NOW));
});

test("近いものが2つあるときは、近いほうを採る", () => {
  // 出雲大社と博物館は400mほどしか離れていません。誤差を大きく取ると
  // どちらも半径に入りますが、言えるのは片方だけです。
  const mid = { lat: 35.4014, lng: 132.6875, accuracyM: 300 };
  const got = arrivedAt(mid, itin(), NOW);
  assert.ok(got);
  const other = got.item.id === "s1" ? "s2" : "s1";
  const items = itin().days[0].items;
  const dOf = (id) => {
    const p = pointOf(items.find((i) => i.id === id));
    return (p.lat - mid.lat) ** 2 + (p.lng - mid.lng) ** 2;
  };
  assert.ok(dOf(got.item.id) <= dOf(other), "遠いほうを採っています");
});

test("壊れた位置では、何も言わない", () => {
  for (const bad of [null, {}, { lat: "あ", lng: 1 }, { lat: 1 },
                     { lat: Number.NaN, lng: Number.NaN }]) {
    assert.equal(arrivedAt(bad, itin(), NOW), null);
  }
});

test("誤差が入っていなければ、0として扱う", () => {
  // 誤差を返さない端末もあります。**大きいものとして捨てません**
  //（捨てると、その端末では一度も言わないことになります）。
  assert.ok(arrivedAt({ ...IZUMO }, itin(), NOW));
});

// --- 見張り -----------------------------------------------------------------

/** navigator.geolocation の代わり。 */
function fakeGeo() {
  const api = {
    cb: null, err: null, cleared: [],
    watchPosition(cb, err) { api.cb = cb; api.err = err; return 7; },
    clearWatch(id) { api.cleared.push(id); },
    send(lat, lng, accuracy = 20) {
      api.cb?.({ coords: { latitude: lat, longitude: lng, accuracy } });
    },
    fail(code) { api.err?.({ code }); },
  };
  return api;
}

test("1回の測定では言わない。続けて同じ場所なら言う", () => {
  const geo = fakeGeo();
  const seen = [];
  watchArrival({ geolocation: geo, getItinerary: () => itin(),
                 now: () => NOW, onArrive: (f) => seen.push(f.item.id) });
  geo.send(IZUMO.lat, IZUMO.lng);
  assert.equal(seen.length, 0, `${STABLE_FIXES}回そろう前に言っています`);
  geo.send(IZUMO.lat, IZUMO.lng);
  assert.deepEqual(seen, ["s1"]);
});

test("あいだに離れたら、数え直す", () => {
  const geo = fakeGeo();
  const seen = [];
  watchArrival({ geolocation: geo, getItinerary: () => itin(),
                 now: () => NOW, onArrive: (f) => seen.push(f.item.id) });
  geo.send(IZUMO.lat, IZUMO.lng);
  geo.send(STATION.lat, STATION.lng);   // 離れた
  geo.send(IZUMO.lat, IZUMO.lng);
  assert.equal(seen.length, 0);
  geo.send(IZUMO.lat, IZUMO.lng);
  assert.deepEqual(seen, ["s1"]);
});

test("同じ場所を、何度も言わない", () => {
  const geo = fakeGeo();
  const seen = [];
  watchArrival({ geolocation: geo, getItinerary: () => itin(),
                 now: () => NOW, onArrive: (f) => seen.push(f.item.id) });
  for (let i = 0; i < 8; i++) geo.send(IZUMO.lat, IZUMO.lng);
  assert.deepEqual(seen, ["s1"], "境内を歩き回るたびに出ています");
});

test("断られた理由で、言うことを変える", () => {
  // 「使えません」とだけ書くと、自分が拒否したのだと思われます。
  const said = [];
  const geo = fakeGeo();
  watchArrival({ geolocation: geo, getItinerary: () => itin(),
                 onDeny: (w) => said.push(w) });
  geo.fail(1);
  assert.match(said[0], /許可されていません/);
  geo.fail(3);
  assert.match(said[1], /時間がかかって/);
});

test("現在地を使えない端末では、そう言って何もしない", () => {
  const said = [];
  const w = watchArrival({ geolocation: null, onDeny: (x) => said.push(x) });
  assert.match(said[0], /使えません/);
  // 止めようとしても壊れません。
  w.stop();
});

test("止められる", () => {
  const geo = fakeGeo();
  const seen = [];
  const w = watchArrival({ geolocation: geo, getItinerary: () => itin(),
                           now: () => NOW, onArrive: (f) => seen.push(f) });
  w.stop();
  assert.deepEqual(geo.cleared, [7]);
});

test("旅程がまだ無いうちは、何も言わない", () => {
  const geo = fakeGeo();
  const seen = [];
  watchArrival({ geolocation: geo, getItinerary: () => null,
                 onArrive: (f) => seen.push(f) });
  geo.send(IZUMO.lat, IZUMO.lng);
  geo.send(IZUMO.lat, IZUMO.lng);
  assert.equal(seen.length, 0);
});
