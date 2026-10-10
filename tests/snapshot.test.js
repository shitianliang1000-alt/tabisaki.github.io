// 旅程そのもののリンク（js/snapshot.js）。
//
// 条件のリンクは受け取った側で組み直すので、別の旅程になります。
// こちらは画面に出ていたものと同じ時刻・同じ場所が戻ることを確かめます。

import assert from "node:assert/strict";
import test from "node:test";

import { freezeItinerary, thawItinerary } from "../js/history.js";
import { MAX_LINK_CHARS, packTrip, tripCodeFrom, tripLink, unpackTrip }
  from "../js/snapshot.js";

const start = new Date("2026-11-13T09:30:00+09:00");
const end = new Date("2026-11-13T11:00:00+09:00");
const place = { id: "kamakura-1", name: "鶴岡八幡宮", lat: 35.3259, lng: 139.5565,
                description: "鎌倉の中心にある八幡宮", url: "https://example.org",
                v: Array.from({ length: 256 }, (_, i) => i / 256) };
const itin = {
  title: "鎌倉の日帰り",
  days: [{ date: start, items: [
    { kind: "transit", title: "鎌倉駅へ", start: new Date(start - 3600000), end: start,
      from: { id: "tokyo", name: "東京駅", lat: 35.68, lng: 139.76,
              description: "長い説明".repeat(50) },
      to: place },
    { kind: "spot", title: "鶴岡八幡宮", start, end, place, spotId: place.id },
  ] }],
  variants: [{ key: "a" }],
  replan: [{ text: "雨なら…" }],
};
const trip = { departAt: start, arriveBy: new Date("2026-11-13T19:00:00+09:00"),
               origin: { name: "東京駅", lat: 35.68, lng: 139.76 } };
const entry = () => ({ title: itin.title, state: { from: "東京駅" },
                       trip: freezeItinerary(trip), itin: freezeItinerary(itin) });

test("詰めて戻すと、同じ時刻・同じ場所が戻る", async () => {
  const code = await packTrip(entry());
  const out = await unpackTrip(code);
  assert.equal(out.ok, true, out.error);
  const back = thawItinerary(out.trip.itin);
  assert.equal(back.title, "鎌倉の日帰り");
  const spot = back.days[0].items[1];
  assert.equal(spot.start.getTime(), start.getTime());
  assert.equal(spot.place.name, "鶴岡八幡宮");
  assert.equal(spot.place.description, "鎌倉の中心にある八幡宮");
  assert.equal(out.trip.state.from, "東京駅");
});

test("要らないもの（ベクトル・案の一覧・見直し）はリンクに入れない", async () => {
  const out = await unpackTrip(await packTrip(entry()));
  const back = out.trip.itin;
  assert.equal(back.days[0].items[1].place.v, undefined);
  assert.equal(back.variants, undefined);
  assert.equal(back.replan, undefined);
  // 移動の両端は、名前と位置だけ。
  assert.deepEqual(Object.keys(back.days[0].items[0].from).sort(),
                   ["id", "lat", "lng", "name"]);
});

test("リンクは # の後ろに入る（サーバへ送られない）", async () => {
  const url = await tripLink(entry(), "https://example.org/app/index.html");
  assert.ok(url.startsWith("https://example.org/app/index.html#t="));
  assert.ok(url.length <= MAX_LINK_CHARS);
  assert.equal(tripCodeFrom(new URL(url).hash), url.split("#t=")[1]);
  assert.equal(tripCodeFrom("#p=abc"), "");
  assert.equal(tripCodeFrom(""), "");
});

test("途中で切れたリンクは、黙って読み違えずに理由を返す", async () => {
  const code = await packTrip(entry());
  const cut = await unpackTrip(code.slice(0, Math.floor(code.length / 2)));
  assert.equal(cut.ok, false);
  assert.match(cut.error, /切れ|読め|旅程/);
  const other = await unpackTrip("xyz");
  assert.equal(other.ok, false);
});
