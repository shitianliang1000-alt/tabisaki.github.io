// Google Maps Routes API。
//
// ■ 日本では、公共交通の経路が返りません（JAPAN_TRANSIT）
//
//   これは設定の問題でも、時間帯の問題でもありません。Google の経路APIは
//   日本国内の鉄道・バスの経路を返しません。東京→横浜のような、まず
//   間違いなく電車がある区間でも ZERO_RESULTS が返ります（同じ症状は
//   北千里→大阪でも報告されています）。日本の交通事業者のデータが
//   経路APIから引ける形で提供されていないためです。
//
//   したがって travelMode:"TRANSIT" は **投げません**。投げれば必ず
//   失敗し、それでも課金対象のリクエストは1回消費されます。
//
//   代わりに、駅・バス停の位置（js/stops.js）を使って組み立てます。
//
//     出発地 →(徒歩・Routes APIで実測)→ 最寄り駅
//     最寄り駅 →(距離からの目安)→ 目的地の最寄り駅
//     最寄り駅 →(徒歩・Routes APIで実測)→ 目的地
//
//   徒歩は日本でも返るので、端の1kmずつは実測になります。真ん中の
//   駅間だけが目安です。全部を直線距離で見積もっていたときより、
//   「駅から遠い目的地」の扱いがはっきりします。
//
// ■ 費用の設計方針
//
//   ・区間ごとに個別に問い合わせない。1回の computeRoutes に中間地点
//     （intermediates）をまとめて渡し、legs[] で各区間の所要時間を受け取る。
//     6スポットの旅なら 7区間 → リクエスト1回。
//   ・中間地点は10か所まで。11か所以上は上位SKU（Pro）の扱いになります。
//   ・optimizeWaypointOrder は使わない（上位SKU）。順序はこちらで決める。
//   ・交通量を見る routingPreference は使わない（上位SKU）。
//   ・Route Matrix は使わない（要素数ぶん課金されうるため）。
//   ・キーが無い / 失敗した場合は距離からの推定に落ちる。その場合は
//     routed:false を返し、画面に「推定」と出す。

import { TUNING, USE_ROUTES_API } from "./config.js";
import { endpointFor, keyHeaders, usingProxy } from "./endpoints.js";
import { effectiveConfig } from "./settings.js";
import { QuotaBlockedError, meteredFetch } from "./quota.js";
import { estimateMinutes, haversineKm, isSlowTerrain } from "./feasibility.js";
import { nearestStop } from "./stops.js";
import { summarizeTransitLeg, transitFieldMask } from "./transit.js";

/**
 * どこへ投げるか。
 *
 * 毎回読み直します。設定画面で入れたキー（localStorage）が、
 * config.js より優先されます。起動時に1回だけ読むと、設定画面で
 * 保存したあともページを再読み込みするまで効かず、「入れたのに
 * 推定のまま」に見えます。
 */
function net() {
  const c = effectiveConfig();
  return { proxyUrl: c.proxyUrl, mapsKey: c.mapsKey };
}

/** 経路を呼べる状態か。プロキシ経由なら、キーはサーバーが持っています。 */
export function hasMapsAccess() {
  const c = net();
  return usingProxy(c) || Boolean(c.mapsKey);
}

/** 秒文字列 "1234s" を秒数に。 */
function parseDuration(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
    if (m) return parseFloat(m[1]);
    const n = parseFloat(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/**
 * 公共交通に渡す出発時刻。
 *
 * 時刻表は先の日付ぶんまで公開されていません。半年先・1年先の日時で
 * 問い合わせると、経路そのものが「見つかりません」で返ります
 * （実際に 2026年9月の旅程で全区間が推定に落ちていました）。
 *
 * 所要時間に効くのは「曜日と時刻」で、何週間先かはほとんど効きません。
 * そこで、遠い日付は **同じ曜日・同じ時刻の直近の日** に置き換えます。
 * 置き換えたことは modeNote で伝えます。
 */
export const TRANSIT_HORIZON_DAYS = 45;

/**
 * 便のある時間帯に寄せます。
 *
 * 旅程の時刻は、こちらが計算した「ちょうどの時刻」です。6:54 発の
 * ローカル線はまず走っていません。その瞬間で問い合わせると
 * 「経路が見つかりません」が返り、**その区間だけでなく旅程ぜんぶが
 * 推定に落ちていました**。
 *
 * 始発前・終電後は、いちばん近い運行時間帯に寄せて聞き直します。
 * 所要時間の目安としてはそれで足ります（寄せたことは画面に出します）。
 */
/**
 * 1リクエストに入れられる地点の数（出発地＋中間地点＋終点）。
 * 中間地点が11か所以上になると上位SKU（Pro）の扱いになるため、
 * 中間地点10か所ぶんの12で切ります。
 */
export const MAX_POINTS = 12;

const SERVICE_FROM = 7;
const SERVICE_TO = 21;

export function clampToService(date) {
  const d = new Date(date);
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < SERVICE_FROM) { d.setHours(SERVICE_FROM, 30, 0, 0); return d; }
  if (h > SERVICE_TO) {
    d.setDate(d.getDate() + 1);
    d.setHours(SERVICE_FROM + 1, 0, 0, 0);
    return d;
  }
  return d;
}

/**
 * 出発時刻を指定しない問い合わせに使う、当たりさわりのない日時。
 *
 * 出発時刻を送らないと、Google 側は「いまこの瞬間」で調べます。すると
 * 深夜に押しただけで東京→横浜すら「経路が見つかりません」になり、
 * キーの問題と見分けがつかなくなります（設定の「確認」が実際そうでした）。
 * しかも departureTime が無いと departedAt も null になるため、
 * 「便のある時間帯へ寄せて聞き直す」再試行も動きません。
 *
 * 押した時刻に結果が左右されないよう、次の平日の10時に固定します。
 */
export function neutralDepartureTime(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  // 土日は本数が減る路線があるので、平日まで送ります。
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}

export function transitDepartureTime(date, now = new Date()) {
  const ahead = (date - now) / 86400000;
  if (ahead < 0) return new Date(now.getTime() + 60000);
  if (ahead <= TRANSIT_HORIZON_DAYS) return new Date(date);

  // 同じ曜日・同じ時刻で、いまから7〜13日後にあたる日
  const target = new Date(now);
  target.setDate(target.getDate() + 7);
  const diff = (date.getDay() - target.getDay() + 7) % 7;
  target.setDate(target.getDate() + diff);
  target.setHours(date.getHours(), date.getMinutes(), 0, 0);
  return target;
}

/**
 * 最後に降りたあとの徒歩（分）。
 *
 * 「駅に着く時刻」と「目的地に着く時刻」は違います。降りたあとの
 * 徒歩を足さないと、駅前に着いた時刻を到着として扱うことになります。
 */
function tailWalkMinutes(segments) {
  let n = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === "ride") break;
    if (segments[i].kind === "walk") n += segments[i].minutes;
  }
  return n;
}

/** 時刻を「8:30」の形に。画面に出す注記で使います。 */
function fmtHm(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function waypoint(p) {
  return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
}

/** 経路全体の移動手段を、点の散らばりから決めます。 */
export function pickMode(points) {
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      max = Math.max(max, haversineKm(points[i], points[j]));
    }
  }
  return max > TUNING.transitThresholdKm ? "TRANSIT" : "WALK";
}

/** 連続した区間のうち、いちばん長いもの（km）。 */
function longestLegKm(points) {
  let max = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    max = Math.max(max, haversineKm(points[i], points[i + 1]));
  }
  return max;
}

/**
 * 失敗が続いたら呼ぶのをやめる。
 *
 * 設定の不備（APIが有効でない・制限に引っかかっている等）は、
 * 何度投げても同じ結果です。それでも呼び続けると、旅程1回につき
 * 数リクエストずつ課金対象の失敗が積み上がります。
 * 2回続けて 4xx が返ったら、そのページを開いている間は呼びません。
 */
const breaker = { fails: 0, open: false, reason: "" };

/**
 * 公共交通の区間ごとの問い合わせに使える回数。旅程1回ぶんの通しです。
 * 経路ごとに数えると、エリアが増えるだけ合計が膨らみます。
 */
const transitBudget = { spent: 0 };

/** 呼び出しの記録。画面で「何回呼んで、何が返ったか」を見せるため。 */
const usage = { calls: 0, failures: 0, lastError: "", skipped: 0 };

export function routesUsage() {
  return { ...usage, breakerOpen: breaker.open, breakerReason: breaker.reason,
           transitSpent: transitBudget.spent };
}

export function routesBreakerState() {
  return { ...breaker };
}

export function resetRoutesBreaker() {
  transitBudget.spent = 0;
  breaker.fails = 0;
  breaker.open = false;
  breaker.reason = "";
  usage.calls = 0;
  usage.failures = 0;
  usage.lastError = "";
  usage.skipped = 0;
}

/**
 * 設定の問題（キーが無効・APIが未有効・参照元の制限）か。
 * これは何度投げても同じ結果なので、1回で止めて構いません。
 */
function isConfigError(status, detail) {
  if (status === 401 || status === 403) return true;
  return status === 400
    && /API[ _]?KEY|api key|PERMISSION_DENIED|not (been )?enabled|referer/i
      .test(detail);
}

function noteFailure(status, detail) {
  usage.failures++;
  usage.lastError = detail;
  if (status < 400 || status >= 500) return;
  // 429（回数制限）は時間が経てば直ります。止めっぱなしにはしません。
  if (status === 429) return;
  if (isConfigError(status, detail)) {
    breaker.open = true;
    breaker.reason = detail;
    return;
  }
  // それ以外の 4xx は、その区間だけの都合（出発時刻が過去だった等）
  // かもしれません。1回で全部を止めると、旅程ぜんぶが推定に落ちます。
  // 3回続いたら、リクエストの形そのものが通っていないと見て止めます。
  breaker.fails++;
  if (breaker.fails >= 3) {
    breaker.open = true;
    breaker.reason = detail;
  }
}

/** Google のエラー本文から、人が読める1行を取り出します。 */
function readableError(text) {
  try {
    const j = JSON.parse(text);
    const e = j?.error;
    if (e?.message) {
      return [e.status, e.message].filter(Boolean).join(" ");
    }
  } catch { /* JSON でなければそのまま */ }
  return text;
}

/**
 * 1区間ぶんの「なんとなくの目安」。
 *
 * 両端の近くに停留所（駅・バス停、js/stops.js）が見つかれば、
 * 「起点→最寄り停留所は徒歩」「停留所どうしは目安の速さ」
 * 「最寄り停留所→終点は徒歩」の3つに分けて見積もります。
 * 見つからなければ、これまでどおり直線距離1本の目安にします。
 *
 * 富士山五合目のような区間（速い公共交通はバス停まで、そこから先は
 * 登山道）を、ぜんぶ同じ速さで計算すると大きく外れるための工夫です。
 * 山まわりのカテゴリ（isSlowTerrain）に触れる徒歩区間だけ、
 * 街なかより遅い速さで見ます。停留所どうしの区間は、バスや鉄道が
 * 走っている前提なのでこれまでの推定式のままです。
 */
async function estimateLegRough(a, b) {
  const direct = estimateMinutes(a, b, {
    slow: isSlowTerrain(a) || isSlowTerrain(b),
  });
  const directKm = haversineKm(a, b);
  // 短い区間では、停留所を挟む意味がありません（探す手間のほうが大きい）。
  if (directKm <= 1.5) return direct;

  const [stopA, stopB] = await Promise.all([
    nearestStop(a, Math.min(5, directKm / 2)),
    nearestStop(b, Math.min(5, directKm / 2)),
  ]);
  if (!stopA || !stopB) return direct;
  if (stopA.lat === stopB.lat && stopA.lng === stopB.lng) return direct;

  const walkA = estimateMinutes(a, stopA, { slow: isSlowTerrain(a) });
  const walkB = estimateMinutes(stopB, b, { slow: isSlowTerrain(b) });
  const between = estimateMinutes(stopA, stopB);
  const viaStops = walkA + between + walkB;

  // 停留所ぶん大きく遠まわりになるなら、その停留所は的外れだったと見て
  // 直線の目安に戻します。
  return viaStops <= direct * 2.2 ? viaStops : direct;
}

/** 推定にフォールバックしたときの結果。 */
async function estimatedLegs(points) {
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    legs.push({
      minutes: await estimateLegRough(points[i], points[i + 1]),
      meters: Math.round(haversineKm(points[i], points[i + 1]) * 1000),
      line: null,
      routed: false,
    });
  }
  return { legs, routed: false };
}

/**
 * リクエストの中身を組み立てます。
 *
 * 送る前の形をテストできるように、送信とは分けてあります。
 * 「TRANSIT に経由地を付けて 400 が返る」類の不具合は、
 * 実際に叩かなくてもここで捕まえられます。
 *
 * @returns {{body:object, fieldMask:string, mode:string, modeNote:string|null}}
 */
export function buildRouteRequest(points, opts = {}) {
  const mode = opts.mode ?? pickMode(points);
  // Routes API の制約: 公共交通（TRANSIT）は経由地を受け付けません。
  // 経由地つきで投げられるのは DRIVE / WALK / BICYCLE だけです。
  //
  // ここで TRANSIT を DRIVE に読み替えるのは誤りでした。鉄道とバスで動く
  // 旅程を、車の所要時間で組むことになります。とくに地方では、
  // 1時間に1本のバス区間を車の10分として計算してしまい、
  // 「時間内に収まる」と判定した旅程が現地で破綻します。
  // このアプリが防ぐはずの失敗そのものです。
  //
  // 経由地つきの公共交通は computeRoute が区間ごとに分けて取りにいくので、
  // ここに来ることはありません。来たなら呼び出し側の誤りなので止めます。
  if (mode === "TRANSIT" && points.length > 2) {
    throw new Error("公共交通に経由地は指定できません（区間ごとに分けてください）");
  }
  const effective = mode;
  let modeNote = null;
  if (mode === "TRANSIT" && opts.departAt
      && (opts.departAt - Date.now()) / 86400000 > TRANSIT_HORIZON_DAYS) {
    modeNote = "出発が先すぎて時刻表が公開されていないため、"
      + "同じ曜日・時刻の直近の日で所要時間を調べています";
  }

  const body = {
    origin: waypoint(points[0]),
    destination: waypoint(points[points.length - 1]),
    travelMode: effective,
    languageCode: "ja",
    units: "METRIC",
  };
  if (points.length > 2) {
    body.intermediates = points.slice(1, -1).map(waypoint);
    // 順序の最適化フラグは、車と二輪のときだけ受け付けられます。
    // 徒歩に付けて投げると 400 が返ります（4xx が半分近く出ていた原因の一つ）。
    // 既定は false なので、送らないこと自体が「順序を触らせない」ことです。
    if (effective === "DRIVE" || effective === "TWO_WHEELER") {
      body.optimizeWaypointOrder = false;
    }
  }
  let departedAt = null;
  if (effective === "TRANSIT") {
    if (opts.departAt) {
      departedAt = transitDepartureTime(opts.departAt);
      body.departureTime = departedAt.toISOString();
    }
  } else if (effective === "DRIVE") {
    // 交通量を見ない設定にして、基本SKUの範囲に収めます。
    // この設定では departureTime を送りません（併用は受け付けられません）。
    body.routingPreference = "TRAFFIC_UNAWARE";
  }

  const fieldMask = [
    "routes.duration",
    "routes.distanceMeters",
    "routes.legs.duration",
    "routes.legs.distanceMeters",
    // 乗換の中身は公共交通のときだけ返ります。他のモードで要求すると
    // フィールドマスク不正になる場合があるので、モードで出し分けます。
    ...(effective === "TRANSIT" ? transitFieldMask() : []),
  ].join(",");

  return { body, fieldMask, mode: effective, modeNote, departedAt };
}

/**
 * 経路全体を1回で取得します。
 *
 * @param {Array<{lat,lng}>} points 出発地 → 経由地… → 終点（2点以上）
 * @param {object} [opts]
 * @param {Date}   [opts.departAt]  TRANSIT のときの出発時刻（時刻表に効く）
 * @param {string} [opts.mode]      省略時は散らばりから自動判定
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{legs: Array<{minutes,meters,line,routed}>, routed: boolean,
 *                    mode: string, error?: string}>}
 */
/**
 * 同じ問い合わせを繰り返さないための控え。
 *
 * 案を作り直すと verifyProposal がもう一度走り、同じ経路を取り直して
 * いました。1回の旅程作成で 3リクエストのはずが 6 になっていた原因です。
 */
const routeCache = new Map();

const cacheKey = (points, mode, departAt) =>
  `${mode}|${departAt ? Math.floor(departAt.getTime() / 600000) : "-"}|`
  + points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";");

export function clearRouteCache() { routeCache.clear(); }

/**
 * 公共交通の区間を、駅の位置から組み立てます。
 *
 * Googleの経路APIは日本の公共交通を返さないので（JAPAN_TRANSIT）、
 * 1区間を3つに分けて考えます。
 *
 *   出発地 →(徒歩)→ 最寄り駅 →(乗車)→ 目的地の最寄り駅 →(徒歩)→ 目的地
 *
 * 徒歩の部分は日本でも経路APIが返すので、**実測できます**。
 * 乗車の部分だけが距離からの目安です。全部を直線距離で見積もっていた
 * ときと比べて、「駅から遠い目的地」が正しく重くなります。
 *
 * 徒歩の実測は、旅程1回あたりの上限（TUNING.maxTransitRequests）まで。
 * 歩きが長い区間から順に使います。目安との差がいちばん大きいのは
 * そこだからです（駅前の300mを実測しても、答えはほとんど変わりません）。
 */
async function computeViaStations(points, opts) {
  const n = points.length - 1;
  // 海をまたぐ距離は、駅どうしの移動ではありません。線路が続いていない
  // ところを「最寄り駅から最寄り駅へ」と書くと、いかにも乗れるように
  // 読めてしまいます。空路として、距離からの目安に任せます。
  const longest = longestLegKm(points);
  if (longest > 700) {
    return { ...(await estimatedLegs(points)), mode: "TRANSIT",
             error: `区間が長すぎます（最長 ${Math.round(longest)}km）。`
               + "空路のため経路検索は行いません" };
  }
  const plans = [];
  for (let i = 0; i < n; i++) {
    plans.push(await planStationLeg(points[i], points[i + 1]));
  }

  // 歩きの長い区間から実測します。
  const budget = Math.max(0,
    (TUNING.maxTransitRequests ?? 8) - transitBudget.spent);
  const order = plans
    .map((p, i) => ({ i, km: p.walkKm }))
    .filter((x) => x.km > 0.4)      // 駅前の数百mは測る意味がありません
    .sort((a, b) => b.km - a.km)
    .slice(0, budget);

  let measured = 0;
  for (const { i } of order) {
    const p = plans[i];
    if (!p.fromStop && !p.toStop) continue;
    const walked = await measureWalks(p, opts);
    if (walked) { plans[i] = walked; measured++; transitBudget.spent++; }
  }

  const legs = plans.map((p, i) => ({
    minutes: p.minutes,
    meters: Math.round(haversineKm(points[i], points[i + 1]) * 1000),
    line: null,
    // 真ん中（乗車）が目安なので、区間としては実測扱いにしません。
    routed: false,
    stations: p.fromStop && p.toStop
      ? { from: p.fromStop.name, to: p.toStop.name, walkMeasured: p.walkMeasured }
      : null,
  }));

  const viaStations = plans.filter((p) => p.fromStop && p.toStop).length;
  const note = viaStations
    ? `${n}区間のうち${viaStations}区間を、最寄りの駅・バス停どうしの`
      + "移動として見ています"
      + (measured ? `（うち${measured}区間は駅までの徒歩を実測）` : "")
    : null;
  return { legs, routed: false, mode: "TRANSIT", modeNote: note,
           requests: measured };
}

/** 1区間ぶんの組み立て（まだ経路APIは呼びません）。 */
async function planStationLeg(a, b) {
  const directKm = haversineKm(a, b);
  // 歩ける距離の駅を探します。10km先の駅まで歩く旅程は組めません。
  const reach = Math.max(1.5, Math.min(5, directKm / 3));
  const [fromStop, toStop] = await Promise.all([
    nearestStop(a, reach), nearestStop(b, reach),
  ]);
  const usable = fromStop && toStop
    && !(fromStop.lat === toStop.lat && fromStop.lng === toStop.lng);
  if (!usable) {
    return { minutes: await estimateLegRough(a, b), walkKm: 0,
             fromStop: null, toStop: null, walkMeasured: false };
  }
  const walkA = estimateMinutes(a, fromStop, { slow: isSlowTerrain(a) });
  const walkB = estimateMinutes(toStop, b, { slow: isSlowTerrain(b) });
  const ride = estimateMinutes(fromStop, toStop);
  const viaStations = walkA + ride + walkB;
  const direct = await estimateLegRough(a, b);
  // 駅を経由するほうが大きく遠回りなら、その駅は的外れです。
  if (viaStations > direct * 2.2) {
    return { minutes: direct, walkKm: 0, fromStop: null, toStop: null,
             walkMeasured: false };
  }
  return { minutes: viaStations, walkKm: fromStop.km + toStop.km,
           a, b, fromStop, toStop, walkA, walkB, ride, walkMeasured: false };
}

/** 駅までの徒歩を、経路APIで実測して置き換えます。 */
async function measureWalks(plan, opts) {
  const { a, b, fromStop, toStop, ride } = plan;
  const [ra, rb] = await Promise.all([
    computeRouteUncached([a, fromStop], { ...opts, mode: "WALK" }),
    computeRouteUncached([toStop, b], { ...opts, mode: "WALK" }),
  ]);
  const walkA = ra.legs[0]?.routed ? ra.legs[0].minutes : plan.walkA;
  const walkB = rb.legs[0]?.routed ? rb.legs[0].minutes : plan.walkB;
  if (!ra.legs[0]?.routed && !rb.legs[0]?.routed) return null;
  return { ...plan, walkA, walkB, minutes: walkA + ride + walkB,
           walkMeasured: true };
}

export async function computeRoute(points, opts = {}) {
  const mode = opts.mode ?? pickMode(points);
  // 公共交通は、Googleの経路APIには投げません（JAPAN_TRANSIT）。
  // 日本国内では必ず「経路が見つかりません」が返り、それでも課金対象の
  // リクエストは消費されます。駅の位置から組み立てます。
  if (mode === "TRANSIT") {
    const key = cacheKey(points, "TRANSIT-stations", opts.departAt);
    const hit = routeCache.get(key);
    if (hit) return hit;
    const result = await computeViaStations(points, opts);
    routeCache.set(key, result);
    return result;
  }
  const key = cacheKey(points, mode, opts.departAt);
  const hit = routeCache.get(key);
  if (hit) return hit;
  const result = await computeRouteUncached(points, { ...opts, mode });
  routeCache.set(key, result);
  return result;
}

async function computeRouteUncached(points, opts = {}) {
  const mode = opts.mode;
  if (points.length < 2) return { legs: [], routed: false, mode };
  // 中間地点は10か所まで。
  //
  // Routes API 自体は25か所ほど受け付けますが、**11か所以上は上位SKU（Pro）
  // の扱いになります**。基本料金（Essentials）に収めたいので、ここで切ります。
  // 超える経路は分割せず推定にします（分割すると結局リクエストが増えて、
  // 費用を抑える目的から外れるため）。
  if (points.length > MAX_POINTS) {
    return { ...(await estimatedLegs(points)), mode, error: "地点数が多すぎます" };
  }
  // 空路になる距離は、そもそも経路が引けません（海をまたぐ区間も同じ）。
  // 投げれば ZERO_RESULTS か 4xx が返るだけなので、呼ばずに推定にします。
  // キーの有無より先に見ます。キーがあっても呼ぶべきでない呼び出しだからです。
  const longest = longestLegKm(points);
  if (longest > 700) {
    return { ...(await estimatedLegs(points)), mode,
             error: `区間が長すぎます（最長 ${Math.round(longest)}km）。`
               + "空路のため経路検索は行いません" };
  }
  if (!hasMapsAccess()) {
    return { ...(await estimatedLegs(points)), mode,
             error: "経路APIのキーが未設定です（⚙ 設定 → 開発者向け から入力できます）" };
  }
  if (!USE_ROUTES_API) {
    usage.skipped++;
    return { ...(await estimatedLegs(points)), mode,
             error: "config.js の USE_ROUTES_API が false です" };
  }
  // 続けて失敗している間は呼びません。原因が直るまで課金だけが増えるためです。
  if (breaker.open) {
    return { ...(await estimatedLegs(points)), mode,
             error: `Routes API の呼び出しを停止しています（${breaker.reason}）` };
  }

  const { body, fieldMask, mode: effective, modeNote, departedAt } =
    buildRouteRequest(points, { ...opts, mode });

  usage.calls++;
  try {
    // 使用量の確認をここに置きます。数えるだけの場所に置くと、
    // 「やめる」を選んだあとも呼び続けてしまいます。
    const cfg = net();
    const res = await meteredFetch("routes", endpointFor("routes", {}, cfg), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...keyHeaders("maps", cfg),
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = `Routes API ${res.status}: ${readableError(text).slice(0, 200)}`;
      noteFailure(res.status, detail);
      return { ...(await estimatedLegs(points)), mode, modeNote, error: detail };
    }
    breaker.fails = 0;   // 1回でも通れば数え直し
    let data = await res.json();
    let route = data?.routes?.[0];

    if (!route?.legs?.length) {
      // 何が起きたのかを、そのまま残します。
      // 「経路が見つかりません」だけでは、設定の問題なのか、その区間に
      // 経路が無いだけなのかが切り分けられません。
      const why = effective === "TRANSIT"
        ? "その区間に公共交通が見つかりませんでした"
          + "（便のある時間帯でも試しています。バスしか無い区間や、"
          + "時刻表が未公開の先の日付で起きます）"
        : "その区間に道路経路が見つかりませんでした（海をまたぐ区間など）";
      usage.lastError = `ZERO_RESULTS: ${why}`;
      return { ...(await estimatedLegs(points)), mode, modeNote,
               error: `経路が見つかりません — ${why}` };
    }

    const legs = route.legs.map((leg) => {
      const out = {
        minutes: Math.max(1, Math.round(parseDuration(leg.duration) / 60)),
        meters: leg.distanceMeters ?? 0,
        line: null,
        routed: true,
      };
      if (effective !== "TRANSIT") return out;
      // 乗換・待ち時間・乗車時刻まで読み解きます。所要時間だけを出しても、
      // 現地で「いま予定どおりか」を確かめられないためです。
      const t = summarizeTransitLeg(leg, { startAt: departedAt });
      out.line = t.line;
      if (t.segments.length) out.transit = t;

      // **最初の電車を待つ時間を足します。**
      //
      // Routes API の leg.duration は、乗ってから降りるまでを返します。
      // 9:00 に駅へ着いて、次の電車が 9:35 なら、その35分は入りません。
      // その値をそのまま旅程に置くと、実際より早く着く前提で組むことに
      // なり、次の予定が押します。「経路APIを使っているのに、
      // ちゃんとした時間が出ない」のはこれでした。
      //
      // 出発時刻と、最初の乗車時刻の両方が分かるときだけ足します。
      // 分からないものを推測で埋めることはしません。
      if (departedAt && t.lastArriveAt) {
        const doorToDoor = Math.round((t.lastArriveAt - departedAt) / 60000);
        // 降りたあとの徒歩は duration に含まれるので、足し戻します。
        const afterWalk = tailWalkMinutes(t.segments);
        const real = doorToDoor + afterWalk;
        if (real > out.minutes) {
          out.waitedMinutes = real - out.minutes;
          out.minutes = real;
        }
      }
      return out;
    });

    // 区間数が合わない場合は足りないぶんを推定で補う（結果が壊れないように）
    while (legs.length < points.length - 1) {
      const i = legs.length;
      legs.push({
        minutes: estimateMinutes(points[i], points[i + 1]),
        meters: Math.round(haversineKm(points[i], points[i + 1]) * 1000),
        line: null, routed: false,
      });
    }
    return { legs, routed: legs.some((l) => l.routed), mode: effective, modeNote };
  } catch (e) {
    if (e instanceof QuotaBlockedError) {
      // 呼んでいないので、呼び出し回数には数えません。
      usage.calls--;
      usage.skipped++;
      return { ...(await estimatedLegs(points)), mode, modeNote, error: e.message };
    }
    return { ...(await estimatedLegs(points)), mode, modeNote,
             error: String(e?.message ?? e) };
  }
}

/**
 * 2点間だけを知りたいとき（出発地→最初のスポット など）。
 * 内部的には computeRoute を使うので、呼び出し回数の考え方は同じです。
 */
export async function computeLeg(from, to, opts = {}) {
  const r = await computeRoute([from, to], opts);
  return r.legs[0] ?? {
    minutes: estimateMinutes(from, to),
    meters: Math.round(haversineKm(from, to) * 1000),
    line: null, routed: false,
  };
}

/**
 * 経路の所要時間から、区間ごとの移動時間を引ける関数を作ります。
 * スケジューラはこれを travelFn として使うので、Routes API の有無に
 * かかわらず同じコードで動きます。
 */
export function legLookup(points, legs) {
  return legLookupAll([[points, legs]]);
}

const pairKey = (a, b) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}`
  + `->${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;

/**
 * 複数の経路をまとめて1つの travelFn にします。
 * 拠点を移す旅では「エリア内の経路」と「エリア間の経路」を別に取るので、
 * どちらから引いても同じ関数で答えられるようにしておきます。
 *
 * @param {Array<[Array<{lat,lng}>, Array<{minutes:number}>]>} entries
 */
export function legLookupAll(entries) {
  const map = new Map();
  for (const [points, legs] of entries) {
    for (let i = 0; i + 1 < points.length; i++) {
      map.set(pairKey(points[i], points[i + 1]), legs?.[i]?.minutes
        ?? estimateMinutes(points[i], points[i + 1]));
    }
  }
  return (a, b) => map.get(pairKey(a, b)) ?? estimateMinutes(a, b);
}

/**
 * 区間の中身（路線・乗換・待ち時間）を、2点の組から引きます。
 *
 * 所要時間だけを返す legLookupAll とは別に用意しています。時間の計算は
 * verify.js の仕事で、こちらは画面に出すための情報だからです。
 * 混ぜると、表示のために取った情報がスケジュール判定に紛れ込みます。
 *
 * 知らない組には null を返します。推定で埋めるかどうかは呼ぶ側が決めます。
 */
export function legDetailLookup(entries) {
  const map = new Map();
  for (const [points, legs] of entries) {
    if (!legs) continue;
    for (let i = 0; i + 1 < points.length; i++) {
      if (legs[i]) map.set(pairKey(points[i], points[i + 1]), legs[i]);
    }
  }
  return (a, b) => map.get(pairKey(a, b)) ?? null;
}

/**
 * Routes API のキーが実際に使えるかを、1リクエストだけで確かめます。
 *
 * 「キーを入れたのに反映されない」ときの原因は、たいてい次のどれかです。
 * 画面から呼べる形にして、どれなのかをその場で言えるようにしました。
 */
export async function diagnoseMapsKey(signal) {
  if (!hasMapsAccess()) {
    return { ok: false, code: "no-key",
      message: "経路APIのキーが空です。上の欄に Google Maps Platform のキーを"
        + "貼るか、PROXY_URL に自分のバックエンドを設定してください。" };
  }
  // 「確認」は、いまの設定で **必ず1回投げます**。
  // 控え（cache）と停止スイッチ（breaker）を通すと、キーを直したあとも
  // 前の失敗がそのまま返り、「直したのに直らない」に見えます。
  breaker.open = false;
  breaker.fails = 0;
  breaker.reason = "";
  // **徒歩で確かめます。公共交通では確かめられません。**
  //
  // 以前は東京→横浜を TRANSIT で試していました。ところが Google の
  // 経路APIは、日本国内の公共交通の経路を返しません（JAPAN_TRANSIT の
  // コメント参照）。つまり、キーが正しくても必ず「経路が見つかりません」に
  // なります。キーの確認としては、何を確かめているのか分からない試験でした。
  //
  // 徒歩なら日本でも返ります。東京駅→日本橋の1kmで、キーと通信と
  // 課金設定がそろっているかだけを見ます。
  const tokyoStation = { lat: 35.681236, lng: 139.767125 };
  const nihonbashi = { lat: 35.683889, lng: 139.774444 };
  routeCache.delete(cacheKey([tokyoStation, nihonbashi], "WALK", undefined));
  const r = await computeRoute([tokyoStation, nihonbashi],
    { mode: "WALK", signal });
  if (r.routed) {
    return { ok: true, code: "ok",
      message: `Routes API に接続できました（東京駅→日本橋 徒歩約${r.legs[0].minutes}分）。`
        + "\n※ 日本国内では、Googleの経路APIは電車・バスの経路を返しません。"
        + "乗換の時間は、駅の位置からの目安で組み立てます。" };
  }
  const err = r.error ?? "";

  const m = /Routes API (\d+)/.exec(err);
  const status = m ? Number(m[1]) : 0;
  const here = globalThis.location?.origin
    ? `${globalThis.location.origin}/*` : "http://localhost:8000/*";
  const hint = status === 403
    ? "キーは届いていますが拒否されました。Google Cloud で ①Routes API を"
      + "有効化 ②請求先アカウントを紐付け ③キーのAPI制限に Routes API を含める "
      + `④HTTPリファラー制限に今のURL（${here}）を追加、`
      + "の4点をご確認ください。"
    : status === 400
      ? "リクエストが拒否されました。キーの文字列に余分な空白や改行が"
        + "入っていないか、キーの種類（Maps Platform のキー）をご確認ください。"
      : status === 429
        ? "回数制限に達しています。しばらく待つか割り当てをご確認ください。"
        : "ネットワークかブラウザの拡張機能に遮断されている可能性があります。";
  return { ok: false, code: status || "error", message: `${hint}\n詳細: ${err}` };
}
