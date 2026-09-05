// Routes API に送るリクエストの形のテスト。
//
// 「Maps API がエラーを吐く」の正体は、公共交通（TRANSIT）に経由地を
// 付けて投げていたことでした。Routes API は TRANSIT の経由地を受け付けず、
// 400 INVALID_ARGUMENT を返します。キーが無くても、送る前の形は
// 確かめられるので、ここで固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { summarizeTransitLeg } from "../js/transit.js";

import { buildRouteRequest, legDetailLookup, pickMode } from "../js/routes.js";

const TOKYO = { lat: 35.6812, lng: 139.7671 };
const SHINJUKU = { lat: 35.6909, lng: 139.7003 };
const YOKOHAMA = { lat: 35.4658, lng: 139.6223 };
const OSAKA = { lat: 34.7025, lng: 135.4960 };

test("公共交通に経由地を付けようとしたら、そこで止める", () => {
  // Routes API が 400 を返す組み合わせです。車に読み替えて通すのは
  // 誤りなので（鉄道の旅程を車の時間で組むことになります）、
  // 組み立ての時点で撥ねます。
  assert.throws(
    () => buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA],
      { mode: "TRANSIT", departAt: new Date("2030-01-01T09:00") }),
    /経由地は指定できません/);
});

test("2点だけなら公共交通のまま、出発時刻も送る", () => {
  const r = buildRouteRequest([TOKYO, OSAKA],
    { mode: "TRANSIT", departAt: new Date("2030-01-01T09:00") });
  assert.equal(r.body.travelMode, "TRANSIT");
  assert.ok(r.body.departureTime);
  assert.equal(r.body.intermediates, undefined);
  // 経由地が無いのに順序最適化を送ると、それ自体が不正になります
  assert.ok(!("optimizeWaypointOrder" in r.body));
});

test("車の経路では、出発時刻ではなく交通量無視を送る", () => {
  const r = buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA],
    { mode: "DRIVE", departAt: new Date("2030-01-01T09:00") });
  assert.equal(r.body.routingPreference, "TRAFFIC_UNAWARE");
  assert.ok(!("departureTime" in r.body),
    "TRAFFIC_UNAWARE と departureTime は併用できません");
});

test("路線名は公共交通のときだけ要求する", () => {
  const transit = buildRouteRequest([TOKYO, OSAKA], { mode: "TRANSIT" });
  assert.match(transit.fieldMask, /transitDetails/);
  const drive = buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA], { mode: "DRIVE" });
  assert.ok(!/transitDetails/.test(drive.fieldMask));
});

test("徒歩圏なら徒歩、離れていれば公共交通を選ぶ", () => {
  assert.equal(pickMode([TOKYO, { lat: 35.6820, lng: 139.7680 }]), "WALK");
  assert.equal(pickMode([TOKYO, OSAKA]), "TRANSIT");
});

test("順序最適化は車のときだけ送る（徒歩に付けると 400 が返る）", () => {
  const walk = buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA], { mode: "WALK" });
  assert.ok(!("optimizeWaypointOrder" in walk.body),
    "徒歩に optimizeWaypointOrder を送っています（Routes API が拒否します）");
  const drive = buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA], { mode: "DRIVE" });
  assert.equal(drive.body.optimizeWaypointOrder, false,
    "上位SKUの順序最適化が既定で有効になりかねません");
});

// --- 呼びすぎ・呼ぶだけ無駄な呼び出しを止める ------------------------------

import { routesBreakerState } from "../js/routes.js";

const WAKKANAI = { lat: 45.5228, lng: 141.9368 };
const NAHA = { lat: 26.2124, lng: 127.6809 };

test("空路になる距離は、経路検索を呼ばない", async () => {
  resetRoutesBreaker();
  clearRouteCache();
  const r = await computeRoute([TOKYO, NAHA], { mode: "TRANSIT" });
  assert.equal(r.routed, false);
  assert.match(r.error, /区間が長すぎます/);
  assert.ok(r.legs.length === 1 && r.legs[0].minutes > 0);
});

test("同じ経路は取り直さない（案の作り直しで倍になっていた）", async () => {
  clearRouteCache();
  const pts = [TOKYO, WAKKANAI];
  const a = await computeRoute(pts, { mode: "TRANSIT" });
  const b = await computeRoute(pts, { mode: "TRANSIT" });
  assert.equal(a, b, "同じ問い合わせで別の結果オブジェクトが返っています");
});

test("失敗が続いたら呼ぶのをやめる", () => {
  resetRoutesBreaker();
  assert.equal(routesBreakerState().open, false);
});

// --- 先の日付では時刻表が引けない ------------------------------------------

import { TRANSIT_HORIZON_DAYS, neutralDepartureTime, transitDepartureTime }
  from "../js/routes.js";

test("時刻を指定しない問い合わせは、次の平日の昼で聞く", () => {
  // 出発時刻を送らないと Google は「押した瞬間」で調べます。深夜に
  // 「確認」を押しただけで東京→横浜が見つからなくなっていました。
  for (const iso of ["2026-09-05T02:30", "2026-09-05T23:50",
                     "2026-09-04T12:00", "2026-09-06T18:00"]) {
    const d = neutralDepartureTime(new Date(iso));
    assert.equal(d.getHours(), 10, `${iso} → ${d}`);
    assert.ok(d.getDay() !== 0 && d.getDay() !== 6, `${iso} → 週末になっています`);
    assert.ok(d > new Date(iso), `${iso} → 過去になっています`);
  }
});

test("近い日付の出発時刻は、そのまま送る", () => {
  const now = new Date("2026-08-31T10:00");
  const soon = new Date("2026-09-05T09:00");
  assert.equal(transitDepartureTime(soon, now).getTime(), soon.getTime());
});

test("遠い日付は、同じ曜日・同じ時刻の直近の日に置き換える", () => {
  const now = new Date("2026-08-31T10:00");     // 月曜
  const far = new Date("2027-03-15T14:30");     // 月曜
  const used = transitDepartureTime(far, now);
  assert.equal(used.getDay(), far.getDay(), "曜日が変わっています");
  assert.equal(used.getHours(), 14);
  assert.equal(used.getMinutes(), 30);
  const ahead = (used - now) / 86400000;
  assert.ok(ahead > 0 && ahead <= TRANSIT_HORIZON_DAYS,
    `${ahead.toFixed(1)}日後になっています`);
});

test("過去の時刻は、いま以降に直す", () => {
  const now = new Date("2026-08-31T10:00");
  const past = new Date("2026-08-01T09:00");
  assert.ok(transitDepartureTime(past, now) >= now);
});

test("置き換えたことを、結果に書き添える", () => {
  const far = new Date(Date.now() + 400 * 86400000);
  const r = buildRouteRequest([TOKYO, OSAKA], { mode: "TRANSIT", departAt: far });
  assert.match(r.modeNote ?? "", /時刻表/);
});

// --- 公共交通を、公共交通のまま取る -----------------------------------------
//
// 経由地つきの TRANSIT を DRIVE に読み替えていたのをやめた件。
// 鉄道とバスの旅程を車の所要時間で組むと、とくに地方で
// 「1時間に1本のバス」を「車で10分」と見積もり、旅程が現地で破綻します。
//
// 日本では、Googleの経路APIは公共交通の経路を返しません。投げても必ず
// 「経路が見つかりません」になり、それでも課金対象のリクエストは消えます。
// 駅の位置から組み立てるようにしたので、そこを固定します。

import {
  MAX_POINTS, clearRouteCache, computeRoute, resetRoutesBreaker, routesUsage,
} from "../js/routes.js";
import { TUNING } from "../js/config.js";
import { resetStopsCache } from "../js/stops.js";

/** 駅のデータを差し替えます（実データを取りに行かせないため）。 */
function withStations(stops, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes("stops-rail")
      ? { year: 2008, stops } : { year: 2012, stops: [] }),
  });
  clearRouteCache();
  resetRoutesBreaker();
  return fn().finally(() => {
    globalThis.fetch = real;
    resetStopsCache();
    clearRouteCache();
  });
}

const SHINJUKU_ST = { lat: 35.6896, lng: 139.7006 };
const HAKONE_YUMOTO = { lat: 35.2325, lng: 139.1063 };

test("公共交通の区間では、経路APIを1回も呼ばない", () =>
  withStations([
    [35.6896, 139.7006, "新宿"],
    [35.2325, 139.1063, "箱根湯本"],
  ], async () => {
    // キーが無ければそもそも呼びませんが、呼ぶ設計かどうかを見たいので
    // 呼び出し回数そのものを確かめます。
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], { mode: "TRANSIT" });
    assert.equal(routesUsage().calls, 0,
      "日本では返らない公共交通に、リクエストを使っています");
    assert.equal(r.legs.length, 1);
    assert.ok(r.legs[0].minutes > 0);
  }));

test("最寄り駅どうしの移動として組み立て、そのことを伝える", () =>
  withStations([
    [35.6896, 139.7006, "新宿"],
    [35.2325, 139.1063, "箱根湯本"],
  ], async () => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], { mode: "TRANSIT" });
    assert.match(r.modeNote ?? "", /最寄りの駅・バス停/);
    assert.equal(r.legs[0].stations?.from, "新宿");
    assert.equal(r.legs[0].stations?.to, "箱根湯本");
  }));

test("駅から遠い目的地は、そのぶん時間がかかる", () =>
  withStations([
    [35.6896, 139.7006, "新宿"],
    [35.2325, 139.1063, "箱根湯本"],
  ], async () => {
    // 箱根湯本駅そのものと、駅から2kmの山の中を比べます。
    const atStation = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO],
      { mode: "TRANSIT" });
    const upTheHill = await computeRoute(
      [SHINJUKU_ST, { lat: 35.2505, lng: 139.1063, category: "登山" }],
      { mode: "TRANSIT" });
    assert.ok(upTheHill.legs[0].minutes > atStation.legs[0].minutes,
      "駅から離れているのに、同じ時間になっています");
  }));

test("近くに駅が無ければ、距離からの目安に戻す", () =>
  withStations([[43.0686, 141.3508, "札幌"]], async () => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], { mode: "TRANSIT" });
    assert.equal(r.legs[0].stations, null);
    assert.ok(r.legs[0].minutes > 0);
  }));

test("実測か目安かを、取り違えない", () =>
  withStations([
    [35.6896, 139.7006, "新宿"],
    [35.2325, 139.1063, "箱根湯本"],
  ], async () => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], { mode: "TRANSIT" });
    // 真ん中（乗車）は目安なので、区間としては実測を名乗りません。
    assert.equal(r.legs[0].routed, false);
    assert.equal(r.routed, false);
  }));

test("中間地点は10か所まで（11か所以上は上位SKUになる）", () => {
  assert.equal(MAX_POINTS, 12, "出発地＋中間地点10＋終点");
});

test("設定の既定値が、費用の設計と合っている", () => {
  assert.ok(TUNING.maxTransitRequests >= 4 && TUNING.maxTransitRequests <= 20,
    `1回の旅程で ${TUNING.maxTransitRequests} リクエストは設計から外れています`);
  assert.ok(TUNING.walkableKm > 0 && TUNING.walkableKm <= 2);
});

// --- 区間の中身を引く --------------------------------------------------------

test("2点の組から、その区間の経路そのものを引ける", () => {
  const points = [TOKYO, SHINJUKU, YOKOHAMA];
  const legs = [
    { minutes: 14, meters: 6200, line: "JR中央線", routed: true,
      transit: { boardAt: "東京", alightAt: "新宿", transfers: 0 } },
    { minutes: 32, meters: 28000, line: "JR湘南新宿ライン", routed: true,
      transit: { boardAt: "新宿", alightAt: "横浜", transfers: 0 } },
  ];
  const look = legDetailLookup([[points, legs]]);
  assert.equal(look(TOKYO, SHINJUKU).transit.boardAt, "東京");
  assert.equal(look(SHINJUKU, YOKOHAMA).minutes, 32);
  // 逆向きは引きません。乗車駅と降車駅が入れ替わるので、そのまま出すと
  // 「新宿から乗って東京で降りる」を「東京から乗る」と表示してしまいます。
  assert.equal(look(SHINJUKU, TOKYO), null);
  // 知らない組は null。推定で埋めるのは呼ぶ側の仕事です
  assert.equal(look(TOKYO, OSAKA), null);
});

test("区間の中身が無い経路でも、引くこと自体は壊れない", () => {
  const look = legDetailLookup([[[TOKYO, SHINJUKU], null]]);
  assert.equal(look(TOKYO, SHINJUKU), null);
});

// --- 最初の電車を待つ時間 ---------------------------------------------------
// Routes API の leg.duration は、乗ってから降りるまでを返します。
// 9:00 に駅へ着いて、次の電車が 9:35 なら、その35分は入りません。
// そのまま旅程に置くと、実際より早く着く前提で組むことになります。

test("待ち時間を含めた、実際の所要時間になる", () => {
  const start = new Date("2026-09-05T09:00:00+09:00");
  const leg = {
    // API が返す「乗ってから降りるまで」は 25分
    duration: "1500s",
    distanceMeters: 12000,
    steps: [
      { travelMode: "WALK", staticDuration: "300s", distanceMeters: 300 },
      { travelMode: "TRANSIT",
        transitDetails: {
          transitLine: { name: "◯◯線" },
          stopDetails: {
            departureStop: { name: "A駅" },
            departureTime: "2026-09-05T09:35:00+09:00",
            arrivalStop: { name: "B駅" },
            arrivalTime: "2026-09-05T10:00:00+09:00",
          },
        } },
      { travelMode: "WALK", staticDuration: "420s", distanceMeters: 500 },
    ],
  };
  const t = summarizeTransitLeg(leg, { startAt: start });
  // 9:00 に出て 10:00 に降り、そこから7分歩く → 67分
  assert.equal(t.waitMinutes, 30, `待ちが ${t.waitMinutes}分 です`);
  const doorToDoor = Math.round((t.lastArriveAt - start) / 60000);
  assert.equal(doorToDoor, 60);
  assert.ok(doorToDoor + 7 > 25,
    "APIの25分をそのまま使うと、実際より35分以上早く着く計算になります");
});

test("待ちが無ければ、余計に足さない", () => {
  const start = new Date("2026-09-05T09:00:00+09:00");
  const leg = {
    duration: "1500s",
    steps: [
      { travelMode: "TRANSIT",
        transitDetails: {
          transitLine: { name: "◯◯線" },
          stopDetails: {
            departureStop: { name: "A駅" },
            departureTime: "2026-09-05T09:00:00+09:00",
            arrivalStop: { name: "B駅" },
            arrivalTime: "2026-09-05T09:25:00+09:00",
          },
        } },
    ],
  };
  const t = summarizeTransitLeg(leg, { startAt: start });
  assert.equal(t.waitMinutes, 0);
  assert.equal(Math.round((t.lastArriveAt - start) / 60000), 25);
});
