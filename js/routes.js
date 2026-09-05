// Google Maps Routes API。
//
// 費用の設計方針（ご指摘を反映）:
//
//   ・区間ごとに個別に問い合わせない。1回の computeRoutes に中間地点
//     （intermediates）をまとめて渡し、legs[] で各区間の所要時間を受け取る。
//     6スポットの旅なら 7区間 → リクエスト1回。
//   ・optimizeWaypointOrder は既定で使わない。順序最適化は上位SKUに
//     なりうるため、順序はこちら側のスケジューラで決める。
//   ・Route Matrix は使わない（要素数ぶん課金されうるため）。
//   ・キーが無い / 失敗した場合は距離からの推定に落ちる。その場合は
//     routed:false を返し、画面に「推定」と出す。

import { MAPS_API_KEY, PROXY_URL, TUNING, USE_ROUTES_API }
  from "./config.js";
import { endpointFor, keyHeaders, usingProxy } from "./endpoints.js";
import { QuotaBlockedError, meteredFetch } from "./quota.js";
import { estimateMinutes, haversineKm } from "./feasibility.js";
import { summarizeTransitLeg, transitFieldMask } from "./transit.js";

/** どこへ投げるか。PROXY_URL があれば自分のサーバーへ向きます。 */
const NET = { proxyUrl: PROXY_URL, mapsKey: MAPS_API_KEY };

/** 経路を呼べる状態か。プロキシ経由なら、キーはサーバーが持っています。 */
function hasMapsAccess() {
  return usingProxy(NET) || Boolean(MAPS_API_KEY);
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

function noteFailure(status, detail) {
  usage.failures++;
  usage.lastError = detail;
  if (status >= 400 && status < 500) {
    breaker.fails++;
    if (breaker.fails >= 2) {
      breaker.open = true;
      breaker.reason = detail;
    }
  }
}

/** 推定にフォールバックしたときの結果。 */
function estimatedLegs(points) {
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    legs.push({
      minutes: estimateMinutes(points[i], points[i + 1]),
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
 * 経由地のある公共交通の経路を、区間ごとに分けて取ります。
 *
 * 公共交通は経由地をまとめられないので、正確に取るなら区間ごとに
 * 1リクエスト要ります。全区間ぶん投げると費用が跳ねるので、次のように
 * 配分します。
 *
 *   ・徒歩でつながる区間 … まとめて1回（WALK は経由地を受け付けます）
 *   ・残りは長い区間から … 予算の範囲で1区間ずつ公共交通で
 *   ・予算を使い切った先 … 距離からの推定（そのことを結果に出します）
 *
 * 長い区間を優先するのは、そこが旅程の成否を分けるからです。
 * 徒歩5分が7分になっても旅程は壊れませんが、1時間に1本のバス区間を
 * 取り違えると、その日の予定がまるごと崩れます。
 */
/**
 * どの区間を、どのモードで、何回に分けて取りにいくかを決めます。
 *
 * 決めることと、実際に投げることを分けてあります。キーが無くても
 * 「車で代用していないか」「上限を守っているか」を確かめられるようにするためです。
 *
 * @param {Array<{lat,lng}>} points
 * @param {object} opts
 * @param {number} opts.walkableKm 徒歩でつなぐ上限
 * @param {number} opts.budget     公共交通に使える問い合わせ回数
 * @returns {{requests:Array<{mode:string, from:number, to:number}>,
 *            estimated:number[]}}
 *   from/to は区間の添字（points ではなく legs の添字）。
 */
export function planLegRequests(points, { walkableKm = 1.4, budget = 10 } = {}) {
  const n = points.length - 1;
  const dist = [];
  for (let i = 0; i < n; i++) dist.push(haversineKm(points[i], points[i + 1]));

  const covered = new Array(n).fill(false);
  const requests = [];

  // 徒歩でつながるひと続き。3区間以上あるときだけ、まとめて1回で取ります。
  // 1〜2区間のために1リクエスト使うのは割に合いません。歩く速さはほぼ一定で、
  // 10分の徒歩が数分ずれても旅程は壊れませんが、その1回を公共交通に回せば
  // バス1本の取り違えを防げます。
  for (const run of runsOf(dist, (km) => km <= walkableKm)) {
    if (run.to - run.from + 1 < 3) continue;
    requests.push({ mode: "WALK", from: run.from, to: run.to });
    for (let i = run.from; i <= run.to; i++) covered[i] = true;
  }

  // 残りを長い順に、予算の範囲で公共交通として取ります。
  // 長い区間を優先するのは、そこが旅程の成否を分けるからです。
  const rest = [];
  for (let i = 0; i < n; i++) {
    if (!covered[i] && dist[i] > walkableKm) rest.push(i);
  }
  rest.sort((a, b) => dist[b] - dist[a]);

  let spent = 0;
  for (const i of rest) {
    if (spent >= budget) break;
    requests.push({ mode: "TRANSIT", from: i, to: i });
    covered[i] = true;
    spent++;
  }

  const estimated = [];
  for (let i = 0; i < n; i++) if (!covered[i]) estimated.push(i);
  return { requests, estimated };
}

/**
 * 経由地のある公共交通の経路を、区間ごとに分けて取ります。
 *
 * 公共交通は経由地をまとめられないので、正確に取るなら区間ごとに
 * 1リクエスト要ります。全区間ぶん投げると費用が跳ねるため、
 * planLegRequests の配分に従って取り、残りは距離からの推定にします。
 */
async function computeTransitChain(points, opts) {
  const n = points.length - 1;
  const legs = new Array(n).fill(null);
  const errors = [];
  let requests = 0;

  const budgetLeft = Math.max(0,
    (TUNING.maxTransitRequests ?? 10) - transitBudget.spent);
  const plan = planLegRequests(points, {
    walkableKm: TUNING.walkableKm ?? 1.4, budget: budgetLeft,
  });

  for (const req of plan.requests) {
    const slice = points.slice(req.from, req.to + 2);
    const r = await computeRouteUncached(slice, {
      ...opts, mode: req.mode,
      departAt: req.mode === "TRANSIT" ? opts.departAt : undefined,
    });
    requests++;
    if (req.mode === "TRANSIT") transitBudget.spent++;
    if (r.error) errors.push(r.error);
    for (let i = 0; i < r.legs.length; i++) legs[req.from + i] = r.legs[i];
  }

  let estimated = 0;
  for (let i = 0; i < n; i++) {
    if (legs[i]?.routed) continue;
    estimated++;
    legs[i] = {
      minutes: estimateMinutes(points[i], points[i + 1]),
      meters: Math.round(haversineKm(points[i], points[i + 1]) * 1000),
      line: null, routed: false,
    };
  }

  const note = estimated
    ? `${n}区間のうち${n - estimated}区間を経路検索で確認し、`
      + `残り${estimated}区間は距離からの推定です`
    : null;
  return {
    legs, routed: legs.some((l) => l.routed), mode: "TRANSIT",
    modeNote: note, requests,
    error: errors.length ? errors[0] : undefined,
  };
}

/** 条件を満たす区間の、連続したかたまり。 */
function runsOf(values, pred) {
  const runs = [];
  let from = -1;
  values.forEach((v, i) => {
    if (pred(v)) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      runs.push({ from, to: i - 1 });
      from = -1;
    }
  });
  if (from >= 0) runs.push({ from, to: values.length - 1 });
  return runs;
}

export async function computeRoute(points, opts = {}) {
  const mode = opts.mode ?? pickMode(points);
  // 公共交通で経由地があるときは、区間ごとに分けて取ります。
  // 車の所要時間で代用すると、旅程の判定そのものが狂います。
  if (mode === "TRANSIT" && points.length > 2) {
    const key = cacheKey(points, "TRANSIT-chain", opts.departAt);
    const hit = routeCache.get(key);
    if (hit) return hit;
    const result = await computeTransitChain(points, { ...opts, mode });
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
  // Routes API の中間地点は 25 件程度が上限。超える経路は分割せず推定にします
  // （分割すると結局リクエストが増えて、費用を抑える目的から外れるため）。
  if (points.length > 25) {
    return { ...estimatedLegs(points), mode, error: "地点数が多すぎます" };
  }
  // 空路になる距離は、そもそも経路が引けません（海をまたぐ区間も同じ）。
  // 投げれば ZERO_RESULTS か 4xx が返るだけなので、呼ばずに推定にします。
  // キーの有無より先に見ます。キーがあっても呼ぶべきでない呼び出しだからです。
  const longest = longestLegKm(points);
  if (longest > 700) {
    return { ...estimatedLegs(points), mode,
             error: `区間が長すぎます（最長 ${Math.round(longest)}km）。`
               + "空路のため経路検索は行いません" };
  }
  if (!hasMapsAccess()) {
    return { ...estimatedLegs(points), mode, error: "APIキー未設定" };
  }
  if (!USE_ROUTES_API) {
    usage.skipped++;
    return { ...estimatedLegs(points), mode,
             error: "config.js の USE_ROUTES_API が false です" };
  }
  // 続けて失敗している間は呼びません。原因が直るまで課金だけが増えるためです。
  if (breaker.open) {
    return { ...estimatedLegs(points), mode,
             error: `Routes API の呼び出しを停止しています（${breaker.reason}）` };
  }

  const { body, fieldMask, mode: effective, modeNote, departedAt } =
    buildRouteRequest(points, { ...opts, mode });

  usage.calls++;
  try {
    // 使用量の確認をここに置きます。数えるだけの場所に置くと、
    // 「やめる」を選んだあとも呼び続けてしまいます。
    const res = await meteredFetch("routes", endpointFor("routes", {}, NET), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...keyHeaders("maps", NET),
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = `Routes API ${res.status}: ${text.slice(0, 160)}`;
      noteFailure(res.status, detail);
      return { ...estimatedLegs(points), mode, modeNote, error: detail };
    }
    breaker.fails = 0;   // 1回でも通れば数え直し
    let data = await res.json();
    let route = data?.routes?.[0];

    // 便の無い時間帯だったのなら、時間帯を寄せてもう一度だけ聞きます。
    // ここで諦めると、旅程ぜんぶが推定に落ちます。
    if (!route?.legs?.length && effective === "TRANSIT" && departedAt
        && !opts.__retried) {
      const shifted = clampToService(departedAt);
      if (shifted.getTime() !== departedAt.getTime()) {
        const again = await computeRouteUncached(points,
          { ...opts, departAt: shifted, __retried: true });
        if (again?.legs?.some((l) => l.routed)) {
          return { ...again,
            modeNote: [again.modeNote,
              `${fmtHm(departedAt)} 発の便が見つからなかったため、`
              + `${fmtHm(shifted)} 発で見ています`].filter(Boolean).join("／") };
        }
      }
    }

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
      return { ...estimatedLegs(points), mode, modeNote,
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
      return { ...estimatedLegs(points), mode, modeNote, error: e.message };
    }
    return { ...estimatedLegs(points), mode, modeNote,
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
      message: "js/config.js の MAPS_API_KEY が空です。ここにキーを貼るか、"
        + "PROXY_URL に自分のバックエンドを設定してください。" };
  }
  const tokyo = { lat: 35.681236, lng: 139.767125 };
  const yokohama = { lat: 35.465786, lng: 139.622313 };
  const r = await computeRoute([tokyo, yokohama], { mode: "TRANSIT", signal });
  if (r.routed) {
    return { ok: true, code: "ok",
      message: `Routes API に接続できました（東京→横浜 約${r.legs[0].minutes}分）。` };
  }
  const err = r.error ?? "";
  const m = /Routes API (\d+)/.exec(err);
  const status = m ? Number(m[1]) : 0;
  const hint = status === 403
    ? "キーは届いていますが拒否されました。Google Cloud で ①Routes API を"
      + "有効化 ②請求先アカウントを紐付け ③キーのAPI制限に Routes API を含める "
      + "④HTTPリファラー制限に今のURL（http://localhost:8000/* など）を追加、"
      + "の4点をご確認ください。"
    : status === 400
      ? "リクエストが拒否されました。キーの文字列に余分な空白や改行が"
        + "入っていないかご確認ください。"
      : status === 429
        ? "回数制限に達しています。しばらく待つか割り当てをご確認ください。"
        : "ネットワークかブラウザの拡張機能に遮断されている可能性があります。";
  return { ok: false, code: status || "error", message: `${hint}\n詳細: ${err}` };
}
