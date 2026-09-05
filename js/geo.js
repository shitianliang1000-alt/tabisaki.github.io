// 地球ぜんぶを相手にする。
//
// これまでの検証は日本前提でした。都道府県名でなければ弾き、日本の緯度経度の
// 範囲を出たら弾く。だから「パリに行きたい」は収録が無い上に調べることも
// できず、「見つかりません」で止まっていました。
//
// 変えたのは前提です。日本かどうかで分けるのをやめ、
//
//   ・地球上の座標か
//   ・名乗った国と座標が矛盾していないか
//   ・その距離を、どんな手段で、どれくらいかけて移動するのか
//
// を国に依らず判断します。国の中心と半径は、よく行かれる国について
// 持っています。表に無い国は、調べた結果そのものを突き合わせの基準に
// 使い、そのことを「照合できていない」と明示します。

import { haversineKm } from "./feasibility.js";

/** 地球の範囲。ここを外れた座標は、名前が何であれ採用しません。 */
export const EARTH_BOUNDS = { minLat: -85, maxLat: 85, minLng: -180, maxLng: 180 };

/**
 * 国・地域のおおよその中心と許容半径（km）。日本語表記で引きます。
 *
 * 網羅は目的ではありません。「フランスと言いながら南米の座標」のような
 * 取り違えを捕まえるための、粗い物差しです。
 */
export const COUNTRY_CENTER = {
  日本: [36.2, 138.3, 1500],
  韓国: [36.5, 127.9, 400], 大韓民国: [36.5, 127.9, 400],
  台湾: [23.7, 121.0, 300],
  中国: [35.0, 104.0, 2600], 中華人民共和国: [35.0, 104.0, 2600],
  香港: [22.32, 114.17, 60], マカオ: [22.19, 113.55, 40],
  タイ: [15.0, 101.0, 900], ベトナム: [16.0, 107.5, 900],
  シンガポール: [1.35, 103.82, 40], マレーシア: [4.2, 108.0, 1100],
  インドネシア: [-2.5, 118.0, 2600], フィリピン: [12.8, 122.0, 1000],
  カンボジア: [12.6, 104.9, 400], ラオス: [18.2, 103.9, 500],
  ミャンマー: [19.8, 96.1, 900], インド: [22.0, 79.0, 1800],
  ネパール: [28.4, 84.1, 400], スリランカ: [7.9, 80.8, 250],
  モンゴル: [46.9, 103.8, 1200], カザフスタン: [48.0, 67.0, 1600],
  アラブ首長国連邦: [24.0, 54.0, 350], トルコ: [39.0, 35.2, 900],
  イスラエル: [31.4, 35.0, 200], ヨルダン: [31.2, 36.5, 250],
  エジプト: [26.8, 30.8, 800], モロッコ: [31.8, -7.1, 700],
  南アフリカ: [-29.0, 24.0, 900], ケニア: [0.2, 37.9, 600],
  タンザニア: [-6.4, 34.9, 700],
  イギリス: [54.0, -2.5, 700], 英国: [54.0, -2.5, 700],
  アイルランド: [53.2, -8.0, 300],
  フランス: [46.6, 2.4, 600], ドイツ: [51.2, 10.4, 500],
  イタリア: [42.5, 12.6, 700], スペイン: [40.2, -3.6, 700],
  ポルトガル: [39.6, -8.0, 400], オランダ: [52.2, 5.3, 200],
  ベルギー: [50.6, 4.6, 160], スイス: [46.8, 8.2, 200],
  オーストリア: [47.6, 14.1, 300], チェコ: [49.8, 15.5, 300],
  ハンガリー: [47.2, 19.4, 250], ポーランド: [52.0, 19.4, 400],
  ギリシャ: [39.0, 22.0, 500], クロアチア: [45.1, 16.4, 300],
  ノルウェー: [64.5, 12.0, 900], スウェーデン: [62.0, 15.0, 900],
  フィンランド: [64.0, 26.0, 700], デンマーク: [56.1, 9.6, 300],
  アイスランド: [64.9, -19.0, 350], ロシア: [61.5, 100.0, 4000],
  アメリカ: [39.8, -98.6, 2700], アメリカ合衆国: [39.8, -98.6, 2700],
  米国: [39.8, -98.6, 2700],
  ハワイ: [20.8, -156.3, 400], グアム: [13.44, 144.79, 60],
  カナダ: [58.0, -100.0, 3200], メキシコ: [23.6, -102.5, 1400],
  ブラジル: [-14.2, -51.9, 2400], アルゼンチン: [-38.4, -63.6, 1800],
  ペルー: [-9.2, -75.0, 900], チリ: [-35.7, -71.5, 2200],
  オーストラリア: [-25.3, 133.8, 2200], ニュージーランド: [-41.0, 174.0, 900],
  フィジー: [-17.7, 178.0, 300], パラオ: [7.5, 134.6, 80],
  モルディブ: [3.2, 73.2, 400],
};

/** 表記ゆれ。長いものから順に見ます。 */
const COUNTRY_ALIAS = {
  "アメリカ合衆国": "アメリカ", "米国": "アメリカ", "英国": "イギリス",
  "大韓民国": "韓国", "中華人民共和国": "中国", "UK": "イギリス",
  "USA": "アメリカ", "US": "アメリカ",
};

/**
 * 国名から中心と半径を引きます。表記ゆれと部分一致を許します。
 * @returns {{name:string, lat:number, lng:number, radiusKm:number}|null}
 */
export function lookupCountry(name) {
  const s = String(name ?? "").trim();
  if (!s) return null;
  const key = COUNTRY_ALIAS[s] ?? s;
  const hit = COUNTRY_CENTER[key];
  if (hit) return { name: key, lat: hit[0], lng: hit[1], radiusKm: hit[2] };
  // 「フランス共和国」のような書き方
  for (const [k, v] of Object.entries(COUNTRY_CENTER)) {
    if (s.includes(k)) return { name: k, lat: v[0], lng: v[1], radiusKm: v[2] };
  }
  return null;
}

export function onEarth(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= EARTH_BOUNDS.minLat && lat <= EARTH_BOUNDS.maxLat
    && lng >= EARTH_BOUNDS.minLng && lng <= EARTH_BOUNDS.maxLng;
}

/** 日本国内か。国名が無ければ座標で判断します。 */
export function isJapan(place) {
  if (place?.country) return lookupCountry(place.country)?.name === "日本";
  const { lat, lng } = place ?? {};
  return lat >= 20.2 && lat <= 45.8 && lng >= 122.8 && lng <= 154.1;
}

// --- 移動手段と所要時間 -----------------------------------------------------

/**
 * 2地点の移動手段。距離だけで決めます。
 *
 * 700km を超えたあたりから、地上をたどるより飛行機のほうが早くなります。
 * ここを分けないと、東京〜パリが「時速120kmで80時間」になり、
 * どんな海外旅行も「時間内に行けません」で弾かれます。
 */
export function travelModeFor(km) {
  if (km <= 1.4) return "walk";
  if (km <= 40) return "local";
  if (km <= 120) return "rail";
  if (km <= 700) return "express";
  return "flight";
}

/**
 * 空港での手続きにかかる時間（片道・分）。
 * 搭乗手続き・保安検査・搭乗・受託手荷物の受け取り。
 *
 * **市内と空港の往復は含みません。** そちらは空港までの距離から
 * 別に計算します（含めていた頃は、二重に足されていました）。
 */
export const FLIGHT_OVERHEAD_MIN = 170;
/** 国際線の入国審査などの上乗せ。 */
export const INTERNATIONAL_EXTRA_MIN = 90;

/**
 * 直線距離を、実際にたどる距離に直す係数。
 *
 * 線路も道路もまっすぐには通っていません。日本は山が多いので、
 * とくに内陸で開きます。直線のまま計算していたときは、
 * 「松本から網走へ4時間」のような数字が出ていました。
 */
const DETOUR = { local: 1.35, ground: 1.25 };

/**
 * 定期便のある主な空港。
 *
 * これが無いと、**どこからでも飛行機に乗れることになります**。
 * 実際には、空港から遠い土地から遠い土地へは、飛行機を使っても
 * まず空港まで出る時間がかかります。近くに空港が無ければ、
 * 陸路で計算するほうが実態に近くなります。
 *
 * 網羅はしていません。長距離の見積もりを大きく外さないための
 * 目安です（正確な所要時間は Routes API が返します）。
 */
const AIRPORTS = [
  // 便が多く、直行で結ばれていることが多い空港（hub）
  [35.55, 139.78, "羽田", true], [35.77, 140.39, "成田", true],
  [34.79, 135.44, "伊丹", true], [34.43, 135.23, "関西", true],
  [34.86, 136.81, "中部", true], [42.77, 141.69, "新千歳", true],
  [33.59, 130.45, "福岡", true], [26.20, 127.65, "那覇", true],
  // それ以外（多くは乗り継ぎが要ります）
  [43.88, 144.16, "女満別"], [43.67, 142.80, "旭川"], [41.77, 140.82, "函館"],
  [40.73, 140.69, "青森"], [39.62, 141.13, "いわて花巻"], [38.14, 140.92, "仙台"],
  [39.79, 140.03, "秋田"], [38.41, 140.37, "山形"], [37.96, 139.11, "新潟"],
  [36.18, 136.22, "小松"], [36.17, 137.92, "松本"], [35.26, 136.92, "県営名古屋"],
  [34.61, 135.22, "神戸"], [35.51, 134.17, "鳥取"], [35.41, 132.89, "出雲"],
  [34.76, 133.86, "岡山"], [34.44, 132.92, "広島"], [34.15, 131.28, "山口宇部"],
  [34.13, 134.61, "徳島"], [34.21, 134.02, "高松"], [33.83, 132.70, "松山"],
  [33.55, 133.67, "高知"], [33.15, 130.30, "佐賀"], [32.92, 129.91, "長崎"],
  [32.84, 130.85, "熊本"], [33.48, 131.74, "大分"], [31.88, 131.45, "宮崎"],
  [31.80, 130.72, "鹿児島"], [24.78, 125.29, "宮古"], [24.40, 124.25, "新石垣"],
];

/** 乗り継ぎ1回ぶん。地方空港どうしは、まず直行便がありません。 */
const CONNECTION_MIN = 60;

/** いちばん近い空港。距離と、便が多いところかどうかを返します。 */
export function nearestAirport(p) {
  let best = null;
  let bestKm = Infinity;
  for (const [lat, lng, name, hub] of AIRPORTS) {
    const km = haversineKm(p, { lat, lng });
    if (km < bestKm) { bestKm = km; best = { name, hub: Boolean(hub) }; }
  }
  return { km: bestKm, name: best?.name ?? "", hub: best?.hub ?? false };
}

/** いちばん近い空港までの距離（km）。 */
export function airportDistanceKm(p) {
  return nearestAirport(p).km;
}

/**
 * 陸路が通れない海を、どこで渡るか。
 *
 * 本州と北海道は青函トンネル、四国は瀬戸大橋、九州は関門トンネル。
 * 直線距離のまま計算すると、津軽海峡を泳いで渡ることになります。
 * 実際には、いったんその1点まで出てから渡ります。
 */
const CROSSINGS = {
  hokkaido: { lat: 41.30, lng: 140.35, name: "青函" },   // 本州側の入口
  hokkaidoN: { lat: 41.67, lng: 140.66, name: "青函" },  // 北海道側の出口
  shikoku: { lat: 34.43, lng: 133.81, name: "瀬戸大橋" },
  shikokuS: { lat: 34.31, lng: 133.80, name: "瀬戸大橋" },
  kyushu: { lat: 33.95, lng: 130.94, name: "関門" },
  kyushuS: { lat: 33.89, lng: 130.88, name: "関門" },
};

/** その地点が乗っている島。 */
export function islandOf(p) {
  const { lat, lng } = p ?? {};
  if (!Number.isFinite(lat)) return "other";
  if (lat >= 41.35) return "hokkaido";
  if (lat <= 27.5 && lng <= 132) return "okinawa";
  // 四国：瀬戸内海の南側
  if (lat <= 34.45 && lng >= 132.0 && lng <= 134.9 && lat >= 32.7) return "shikoku";
  if (lng <= 131.9 && lat <= 34.0) return "kyushu";
  return "honshu";
}

/**
 * 移動時間の見積もり（分）。
 *
 * @param {{lat,lng,country?}} a
 * @param {{lat,lng,country?}} b
 * @returns {number}
 */
export function travelMinutes(a, b) {
  const direct = haversineKm(a, b);

  // 陸路は、島をまたぐなら渡れる場所を経由します。
  // 空路は海の上をまっすぐ飛ぶので、経由しません。
  // 同じ距離で両方を比べていたときは、東京〜札幌の空路にまで
  // 青函トンネルぶんの時間が乗っていました。
  const cross = crossingDetour(a, b);
  const groundKm = cross ? cross.km : direct;
  const ground = travelByMode(groundKm) + (cross ? cross.extraMin : 0);

  if (islandOf(a) === "okinawa" || islandOf(b) === "okinawa") {
    return flightMinutes(a, b, direct) ?? ground;
  }
  // 700km に満たない距離では、そもそも飛行機を使いません。
  if (travelModeFor(direct) !== "flight") return ground;

  const air = flightMinutes(a, b, direct);
  return air === null ? ground : Math.min(ground, air);
}

/**
 * 距離に応じた、door-to-door の平均速度（km/h）。
 *
 * 距離帯で速度を切り替えていたときは、境目で逆転していました。
 * 40km が「在来線で145分」、64km が「鉄道で120分」。近いほうが
 * 遠いほうより遅い、という数字が出ます。境目のせいで、旅程の
 * 並べ替えが不自然になっていました。
 *
 * 折れ線でつなぎます。乗り換えや待ち時間を含んだ実感の速度なので、
 * 電車そのものの速度より遅くなります。
 *
 *    10km →  22km/h   街なか。歩きと乗り換えが効きます
 *    40km →  40km/h   近郊。在来線
 *   120km →  90km/h   特急
 *   250km → 180km/h   新幹線
 *   500km → 210km/h   新幹線（長距離）
 *   700km → 220km/h
 *  1200km → 150km/h   ここまで来ると、新幹線だけでは行けません
 *  2000km → 120km/h   （在来線・連絡船・乗り継ぎ待ちが入ります）
 *
 * 700km を超えたところで下げているのは、速度が落ちるからではなく、
 * **新幹線の通っていない区間が混じるから**です。奥秩父から知床まで
 * 陸路で行くのに、全部を時速220kmで走れることにすると8時間になります。
 */
function groundSpeedKmh(km) {
  const curve = [[10, 22], [40, 40], [120, 90], [250, 180],
                 [500, 210], [700, 220], [1200, 150], [2000, 120]];
  if (km <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1];
    const [x1, y1] = curve[i];
    if (km <= x1) return y0 + (y1 - y0) * ((km - x0) / (x1 - x0));
  }
  return curve.at(-1)[1];
}

/** 距離だけで決まる、地上の所要時間。 */
function travelByMode(km) {
  if (km <= 1.4) return Math.max(5, Math.round((km / 4.2) * 60) + 4);
  // 線路も道路もまっすぐには通っていません。
  const real = km * DETOUR.ground;
  // 待ち時間。長い区間ほど乗り換えが増えますが、頭打ちにします。
  const wait = Math.min(35, 8 + km * 0.12);
  return Math.round((real / groundSpeedKmh(km)) * 60 + wait);
}

/**
 * 空路の所要時間。両端の近くに空港が無ければ null（飛べません）。
 *
 * これが無いと、**どこからでも飛行機に乗れることになります**。
 * 松本から網走までが「時速800kmで4時間」になっていたのはこれが理由です。
 * 実際には、まず空港まで出る時間がかかり、地方空港どうしなら
 * 乗り継ぎもあります。
 */
function flightMinutes(a, b, km) {
  const crossBorder = a.country && b.country
    && lookupCountry(a.country)?.name !== lookupCountry(b.country)?.name;
  // 国外の空港は収録していません。いちばん近い「日本の」空港までの
  // 距離を使うと、東京〜ソウルの空港アクセスが550kmになります。
  // 国をまたぐときは、両端の空港アクセスを決め打ちにします。
  if (crossBorder) {
    return Math.round((km / 800) * 60) + FLIGHT_OVERHEAD_MIN + 90
      + INTERNATIONAL_EXTRA_MIN;
  }

  const from = nearestAirport(a);
  const to = nearestAirport(b);
  if (from.km > 70 || to.km > 70) return null;

  // 空港までの往復ぶん。0分で着くことはありません。
  const access = Math.round(((from.km + to.km) * DETOUR.local / 45) * 60);
  // 地方空港どうしは、まず直行便がありません。
  const connect = (from.hub && to.hub) ? 0
    : (from.hub || to.hub) ? CONNECTION_MIN : CONNECTION_MIN * 2;
  return Math.round((km / 800) * 60) + FLIGHT_OVERHEAD_MIN + access + connect;
}

/**
 * 島をまたぐときの、経由地を通った距離と上乗せ。
 * またがないなら null を返します。
 *
 * 直線で結ぶと、津軽海峡や瀬戸内海をまっすぐ突っ切ることになります。
 * 本州から北海道へは青函トンネル、四国へは瀬戸大橋、九州へは関門。
 * 上乗せは、その区間の便の少なさです。青函は本数が限られますが、
 * 瀬戸大橋と関門は頻繁に走っているので、同じ扱いにはしません。
 */
function crossingDetour(a, b) {
  const ia = islandOf(a);
  const ib = islandOf(b);
  if (ia === ib || ia === "other" || ib === "other") return null;
  if (ia === "okinawa" || ib === "okinawa") return null;   // 陸路なし

  const pair = [ia, ib].sort().join("-");
  const [via, extraMin] = pair.includes("hokkaido")
    ? [[CROSSINGS.hokkaido, CROSSINGS.hokkaidoN], 45]
    : pair.includes("shikoku")
      ? [[CROSSINGS.shikoku, CROSSINGS.shikokuS], 12]
      : [[CROSSINGS.kyushu, CROSSINGS.kyushuS], 12];
  const [p, q] = haversineKm(a, via[0]) <= haversineKm(a, via[1])
    ? via : [via[1], via[0]];
  return {
    km: haversineKm(a, p) + haversineKm(p, q) + haversineKm(q, b),
    extraMin,
  };
}

/** 画面に出す移動手段の言葉。 */
export function travelLabel(km) {
  return { walk: "徒歩", local: "在来線・バス", rail: "鉄道",
           express: "新幹線・特急", flight: "空路" }[travelModeFor(km)];
}

/**
 * 海外へ行くときに、旅程とは別に伝えるべきこと。
 * 旅程エンジンでは扱えない（けれど旅を左右する）事柄です。
 */
export function overseasNotes(origin, destination) {
  if (!destination) return [];
  const from = isJapan(origin);
  const to = isJapan(destination);
  if (from === to) return [];
  const country = destination.country ?? "渡航先";
  const shift = timezoneShiftHours(origin, destination);
  const notes = [
    `${country}への渡航には、パスポートと（国によっては）査証が要ります。`
    + "有効期限と入国条件を、渡航前に必ずご確認ください。",
    "移動時間には空港での手続き（保安検査・出入国審査）を含めていますが、"
    + "便の時刻までは見ていません。実際の航空便に合わせて調整してください。",
    "料金は現地の相場から円に換算した概算です。為替で変わります。",
  ];
  const dateShift = dateShiftDays(origin, destination);
  if (Math.abs(shift) >= 1 || dateShift) {
    // 時差はこのアプリでは扱えません。扱えないことを黙っているより、
    // 何がずれるのかを書いたほうが役に立ちます。
    const clock = Math.abs(shift) >= 1
      ? `現地の時計は日本より、おおよそ${Math.abs(shift)}時間`
        + `${shift < 0 ? "遅れています" : "進んでいます"}`
      : "現地の時計は日本とほぼ同じです";
    const date = dateShift === 0 ? ""
      : `（日付は${dateShift < 0 ? "1日戻ります" : "1日進みます"}）`;
    notes.push(`${clock}${date}。旅程の時刻はすべて同じ時計で計算しているため、`
      + "現地時刻とはずれます。実際の便に合わせて読み替えてください。");
  }
  return notes;
}

/**
 * 時差（時間）。経度からのおおまかな推定です。
 *
 * 実際の標準時は国の都合で決まるので、1時間ほどずれることがあります
 * （ハワイやインドなど）。日付変更線をまたぐ場合は、短いほうに丸めます。
 * 正確な値ではなく「何時間ずれるか」の桁を伝えるためのものです。
 */
export function timezoneShiftHours(from, to) {
  if (!from || !to) return 0;
  const tz = (p) => Math.round(p.lng / 15);
  let d = tz(to) - tz(from);
  while (d > 12) d -= 24;
  while (d <= -12) d += 24;
  return d;
}

/**
 * 日付が前後にずれるか。
 * 時計の針だけを見ると「4時間進んでいる」でも、ハワイのように
 * 日付が1日戻る場所があります。針と日付は分けて伝えます。
 */
export function dateShiftDays(from, to) {
  if (!from || !to) return 0;
  const tz = (p) => Math.round(p.lng / 15);
  const raw = tz(to) - tz(from);
  // 東京 12:00(月) は ホノルル 17:00(日)。時計は進んで見えますが日付は戻ります。
  if (raw > 12) return 1;
  if (raw <= -12) return -1;
  return 0;
}
