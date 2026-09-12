// 夜行列車を、旅程の区間として組み立てる。
//
// 「サンライズに乗って山陰へ」と書かれても、これまでは注意書きを
// 添えるだけでした。旅程そのものは朝いちの新幹線で組まれ、
// **書いた人の希望がどこにも入りません。**
//
// 夜行はふつうの区間とは違います。
//
//   ・前の日の夜に乗って、翌朝に着く（日をまたぐ）
//   ・その晩の宿は要らない（車内で寝る）
//   ・時刻表は毎日同じ（臨時列車ではなく定期列車）
//
// 3つ目が効きます。毎日同じ時刻で走るので、**表に書いておけます**。
// Yahoo!路線情報は「いま出たら」で答えるので、夜行を狙って引くのは
// 向きません。
//
// 収録するのは、いま定期で走っている夜行列車だけです。
// サンライズ出雲・瀬戸の2本（東京発は併結、岡山で分かれます）。
// ほかの夜行は臨時のみになったため、載せません。
//
// **席が取れるかは、ここでは分かりません。** 寝台は乗車券とは別に
// 寝台券が要り、休前日は早く埋まります。旅程には「乗れたとして」の
// 時刻を置き、確かめかたを添えます。

/**
 * 定期の夜行列車。時刻は2024年3月改正のもの。
 *
 * stops は停車駅を順に並べたものです。lat/lng は、旅程の地点と
 * 突き合わせるために持ちます（名前だけだと、収録の「出雲市」と
 * 駅の「出雲市駅」が別ものになります）。
 *
 * depart/arrive は、その駅を出る／着く時刻（"HH:MM"）。
 * nextDay が true の駅は、乗った日の翌日に着きます。
 */
export const NIGHT_TRAINS = [
  {
    id: "sunrise-izumo",
    name: "サンライズ出雲",
    note: "寝台特急。個室のほか、指定席券だけで乗れる「のびのび座席」があります",
    stops: [
      { name: "東京", lat: 35.6812, lng: 139.7671, depart: "21:50" },
      { name: "横浜", lat: 35.4660, lng: 139.6222, depart: "22:24" },
      { name: "熱海", lat: 35.1047, lng: 139.0781, depart: "23:23" },
      { name: "静岡", lat: 34.9714, lng: 138.3887, depart: "00:20", nextDay: true },
      { name: "浜松", lat: 34.7040, lng: 137.7348, depart: "01:12", nextDay: true },
      { name: "姫路", lat: 34.8266, lng: 134.6903, arrive: "05:25", depart: "05:26", nextDay: true },
      { name: "岡山", lat: 34.6661, lng: 133.9180, arrive: "06:27", depart: "06:34", nextDay: true },
      { name: "米子", lat: 35.4281, lng: 133.3311, arrive: "09:03", depart: "09:04", nextDay: true },
      { name: "松江", lat: 35.4681, lng: 133.0486, arrive: "09:29", depart: "09:30", nextDay: true },
      { name: "出雲市", lat: 35.3661, lng: 132.7549, arrive: "09:58", nextDay: true },
    ],
  },
  {
    id: "sunrise-seto",
    name: "サンライズ瀬戸",
    note: "寝台特急。個室のほか、指定席券だけで乗れる「のびのび座席」があります",
    stops: [
      { name: "東京", lat: 35.6812, lng: 139.7671, depart: "21:50" },
      { name: "横浜", lat: 35.4660, lng: 139.6222, depart: "22:24" },
      { name: "熱海", lat: 35.1047, lng: 139.0781, depart: "23:23" },
      { name: "静岡", lat: 34.9714, lng: 138.3887, depart: "00:20", nextDay: true },
      { name: "浜松", lat: 34.7040, lng: 137.7348, depart: "01:12", nextDay: true },
      { name: "姫路", lat: 34.8266, lng: 134.6903, arrive: "05:25", depart: "05:26", nextDay: true },
      { name: "岡山", lat: 34.6661, lng: 133.9180, arrive: "06:27", depart: "06:31", nextDay: true },
      { name: "高松", lat: 34.3499, lng: 134.0466, arrive: "07:27", nextDay: true },
    ],
  },
];

/** 地球上の2点の距離（km）。feasibility.js と同じ式です。 */
function km(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** その地点から乗り降りできる駅。遠ければ null。 */
const REACH_KM = 25;

function stopNear(train, point, { boarding }) {
  let best = null;
  for (const s of train.stops) {
    if (boarding && !s.depart) continue;
    if (!boarding && !s.arrive && s !== train.stops.at(-1)) continue;
    const d = km(s, point);
    if (d <= REACH_KM && (!best || d < best.km)) best = { stop: s, km: d };
  }
  return best;
}

function hhmmToMinutes(hm) {
  const [h, m] = String(hm ?? "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/**
 * 夜行の区間を組み立てます。乗れなければ null。
 *
 * @param {{lat,lng,name?}} from   出発地
 * @param {{lat,lng,name?}} to     目的地
 * @param {Date} departDate        出発する日（時刻は見ません）
 * @param {string} [prefer]        列車の id（「サンライズ出雲」など指定があれば）
 * @returns {{minutes,line,routed,overnight,boardAt,alightAt,
 *            departure,arrival,train,note}|null}
 */
export function nightTrainLeg(from, to, departDate, prefer = null) {
  if (!from || !to || !(departDate instanceof Date)) return null;
  let best = null;
  for (const train of NIGHT_TRAINS) {
    if (prefer && train.id !== prefer && train.name !== prefer) continue;
    const on = stopNear(train, from, { boarding: true });
    const off = stopNear(train, to, { boarding: false });
    if (!on || !off) continue;
    // 乗る駅は、降りる駅より前でなければなりません。
    if (train.stops.indexOf(on.stop) >= train.stops.indexOf(off.stop)) continue;
    const total = on.km + off.km;
    if (!best || total < best.total) best = { train, on, off, total };
  }
  if (!best) return null;

  const { train, on, off } = best;
  const depMin = hhmmToMinutes(on.stop.depart);
  const arrMin = hhmmToMinutes(off.stop.arrive ?? off.stop.depart);
  if (depMin === null || arrMin === null) return null;

  const board = new Date(departDate);
  board.setHours(0, 0, 0, 0);
  board.setMinutes(depMin);
  const land = new Date(board);
  land.setHours(0, 0, 0, 0);
  // 乗る駅が翌日側（静岡・浜松など深夜発）なら、そこから数えます。
  if (on.stop.nextDay) land.setDate(land.getDate() + 1);
  if (off.stop.nextDay && !on.stop.nextDay) land.setDate(land.getDate() + 1);
  land.setMinutes(arrMin);
  if (land <= board) land.setDate(land.getDate() + 1);

  const minutes = Math.round((land - board) / 60000);
  return {
    minutes,
    // 乗る時刻と着く時刻そのもの。夜行は「出発できる時刻＋所要時間」では
    // 着きません（10時に家を出ても、21:50発の列車は21:50発です）。
    boardAt_: board,
    arriveAt: land,
    rideMinutes: minutes,
    waitMinutes: 0,
    routed: true,
    overnight: true,
    train: train.name,
    boardAt: on.stop.name,
    alightAt: off.stop.name,
    departure: on.stop.depart,
    arrival: off.stop.arrive ?? off.stop.depart,
    line: `${train.name}・${on.stop.name} ${on.stop.depart}発`
      + ` → ${off.stop.name} ${off.stop.arrive ?? off.stop.depart}着`
      + `（車中泊・${Math.floor(minutes / 60)}時間${minutes % 60}分）`,
    note: `${train.name}は${on.stop.name}を${on.stop.depart}に出て、`
      + `翌朝${off.stop.arrive ?? off.stop.depart}に${off.stop.name}へ着きます。`
      + "その晩の宿は取りません（車中泊）。"
      + "寝台券・指定席券はJRの窓口やえきねっとでお求めください"
      + "（休前日は早く埋まります）。",
  };
}
