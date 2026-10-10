// 5泊のように区間が多い旅程で、2周目の調べ直しが回数を食いつぶさない。
//
// 実際の時刻で組み直すと、一部の区間の出発時刻だけが動きます。控えが
// 旅程まるごとの鍵だと、動いていない区間まで聞き直し、回数を使い切って
// 後ろの区間が「目安」に落ちていました。
import assert from "node:assert/strict";
import test from "node:test";

import { TUNING } from "../js/config.js";
import { clearRouteCache, computeRoute, resetRoutesBreaker, resetTransitPacing }
  from "../js/routes.js";
import { resetStopsCache } from "../js/stops.js";

const TOWNS = [
  [35.68, 139.77, "東京"], [34.70, 135.50, "大阪"], [35.01, 135.76, "京都"],
  [34.69, 135.19, "神戸"], [35.17, 136.88, "名古屋"],
];

function trip(n) {
  return Array.from({ length: n }, (_, i) => {
    const [lat, lng, name] = TOWNS[i % TOWNS.length];
    return { name: `${name}${i}`, lat: lat + i * 0.001, lng: lng + i * 0.001 };
  });
}

const RIDE = (body) => ({
  routed: true, minutes: 60, rideMinutes: 60, waitMinutes: 0,
  summary: "09:00 発→ 10:00 着 1時間", byLocation: !!(body.fromAt || body.toAt),
  meta: { departure: "09:00", arrival: "10:00", transfers: 0, fareYen: 1000,
          distanceKm: 40,
          legs: [{ from: body.from, to: body.to, departure: "09:00",
                   arrival: "10:00", minutes: 60, line: "JR" }] },
});

test("2周目は、動いた区間だけ聞き直す", async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("stops-rail")) {
      return { ok: true, json: async () => ({ year: 2008, stops: TOWNS }) };
    }
    if (u.includes("stops-bus")) {
      return { ok: true, json: async () => ({ year: 2012, stops: [] }) };
    }
    const body = JSON.parse(init?.body ?? "{}");
    asked.push(body);
    return { ok: true, json: async () => RIDE(body) };
  };
  const was = TUNING.maxYahooRequests;
  TUNING.maxYahooRequests = 60;
  clearRouteCache(); resetRoutesBreaker(); resetTransitPacing(); resetStopsCache();
  try {
    const pts = trip(40);
    const t0 = new Date("2026-10-11T09:00:00+09:00");
    const times = pts.slice(0, -1).map((_, i) => new Date(t0.getTime() + i * 3 * 3600e3));
    const r1 = await computeRoute(pts, { mode: "TRANSIT", departAt: t0, departTimes: times });
    const first = asked.length;
    assert.ok(r1.legs.filter((l) => l.routed).length >= 35,
      `1周目: ${r1.legs.filter((l) => l.routed).length}区間`);
    // 最後の区間だけ、出発が1時間動いた。
    const times2 = times.slice();
    times2[times2.length - 1] = new Date(times2.at(-1).getTime() + 3600e3);
    const r2 = await computeRoute(pts, { mode: "TRANSIT", departAt: t0, departTimes: times2 });
    assert.ok(asked.length - first <= 4, `2周目に${asked.length - first}回聞いています`);
    assert.ok(r2.legs.filter((l) => l.routed).length >= 35,
      `2周目: ${r2.legs.filter((l) => l.routed).length}区間`);
  } finally {
    globalThis.fetch = real;
    TUNING.maxYahooRequests = was;
    clearRouteCache(); resetStopsCache();
  }
});

test("「三都心」「京阪神」のような言い方も、行き先の指定として読む", async () => {
  const { detectAreas } = await import("../js/areas.js");
  const regions = ["東京", "大阪市", "名古屋", "京都市", "神戸市", "札幌"].map((name, i) => ({
    id: `r${i}`, name, prefecture: "X", stationLat: 35, stationLng: 135,
  }));
  const kb = { regions, regionsById: new Map(regions.map((r) => [r.id, r])) };
  const names = (t) => detectAreas(t, kb).flatMap((a) =>
    a.regionIds.map((id) => kb.regionsById.get(id).name)).sort();
  const three = ["大阪市", "名古屋", "東京"].sort();
  assert.deepEqual(names("さん都心をめぐる5泊の旅"), three);
  assert.deepEqual(names("三都心の美術館"), three);
  assert.deepEqual(names("京阪神でグルメ"), ["京都市", "大阪市", "神戸市"].sort());
  // 「三大都市」と同時に拾って広がらない。
  assert.deepEqual(names("三大都市"), three);
});
