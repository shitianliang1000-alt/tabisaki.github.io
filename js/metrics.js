// 使われかたを、名前の無い件数として数える。
//
// 何が使われ、どこで止まっているのかが分からないと、直す順番を
// 決められません。「旅程をつくった」「組めなかった（圏外で）」
// 「1か所を外した」のような出来事を、**件数だけ**数えます。
//
// 送らないもの
// ------------
//   入力した文・地名・旅程・位置・端末の識別子・Cookie。
//   送るのは決まった出来事の名前（EVENTS）と、決まった言葉の補足
//   （DETAILS）だけです。それ以外の文字列は、ここで落とします。
//   IP は中継（Cloudflare Worker）を通るので届きますが、Worker は
//   保存しません（server/worker.js の metrics）。
//
// 送らないとき
// ------------
//   - 設定で「使われかたの集計に協力する」を外したとき
//   - ブラウザが Global Privacy Control / Do Not Track を出しているとき
//   - 中継（PROXY_URL）が無いとき（自分のキーで動かしている人の分は
//     数えません。そもそも届け先がありません）
//
// 失敗しても黙って捨てます。数えることのために、旅程づくりを1ミリ秒も
// 待たせません（sendBeacon は、ページを閉じる瞬間でも送れて、返事を
// 待ちません）。

/** 数える出来事。ここに無いものは送りません。 */
export const EVENTS = new Set([
  "plan_ok",        // 旅程ができた
  "plan_error",     // 旅程を組めなかった
  "offline_seen",   // 圏外の帯が出た
  "spot_replace",   // 「別の候補」
  "spot_remove",    // 「外す」
]);

/** 補足として許す言葉。ここに無いものは空にします。 */
export const DETAILS = new Set([
  // 移動手段
  "transit", "car", "transit+car", "walk",
  // 組めなかった理由（js/errors.js の kind）
  "plan", "offline", "network", "kb", "quota",
]);

export const METRICS_KEY = "tabisaki.metrics";

/** 集計に協力するか（既定は「する」。設定で外せます）。 */
export function metricsEnabled(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(METRICS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setMetricsEnabled(on, storage = globalThis.localStorage) {
  try {
    storage?.setItem(METRICS_KEY, on ? "on" : "off");
  } catch { /* 保存できない環境では、毎回の既定に戻ります */ }
}

/** ブラウザが「追跡しないで」と言っているか。 */
export function browserOptedOut(nav = globalThis.navigator) {
  if (nav?.globalPrivacyControl === true) return true;
  return nav?.doNotTrack === "1";
}

/**
 * 送る中身を作ります。送れないもの・送らないものは null。
 * @returns {string|null} JSON 文字列
 */
export function metricBody(event, detail = "") {
  if (!EVENTS.has(event)) return null;
  const d = DETAILS.has(detail) ? detail : "";
  return JSON.stringify({ e: event, d });
}

// 圏外のあいだに起きたことは、つながったときに送ります。
// 圏外で送ると捨てられるので、「圏外で組めなかった」がいちばん
// 数えたいのに、いちばん数えられない、ということになります。
// 端末には残しません（このページを開いているあいだだけ持ちます）。
const MAX_QUEUED = 20;
const queued = [];
let listening = false;

/** 圏外のあいだに貯めたぶんを送ります。 */
export function flushQueued(opts = {}) {
  const items = queued.splice(0, queued.length);
  let sent = 0;
  for (const [event, detail] of items) {
    if (track(event, detail, opts)) sent++;
  }
  return sent;
}

/** 試験用。貯めている件数。 */
export function queuedCount() { return queued.length; }

/**
 * 1件数えます。
 *
 * @param {string} event
 * @param {string} [detail]
 * @param {object} [env] 試験のための差し替え
 * @returns {boolean} 送ったかどうか
 */
export function track(event, detail = "", {
  proxyUrl = "",
  nav = globalThis.navigator,
  storage = globalThis.localStorage,
} = {}) {
  const base = String(proxyUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) return false;
  if (!metricsEnabled(storage) || browserOptedOut(nav)) return false;
  const body = metricBody(event, detail);
  if (!body) return false;
  if (nav?.onLine === false) {
    if (queued.length < MAX_QUEUED) queued.push([event, detail]);
    if (!listening && globalThis.addEventListener) {
      listening = true;
      globalThis.addEventListener("online",
        () => flushQueued({ proxyUrl, nav, storage }));
    }
    return false;
  }
  try {
    // text/plain なら、CORS の下見（OPTIONS）が要りません。
    const blob = new Blob([body], { type: "text/plain" });
    return Boolean(nav?.sendBeacon?.(`${base}/metrics`, blob));
  } catch {
    return false;
  }
}
