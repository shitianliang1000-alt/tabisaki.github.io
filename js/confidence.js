// 情報の確からしさを、3段階で伝える。
//
// 旅行では「その情報がどこから来たか」が結果を左右します。
// 公式で確認した営業時間と、分類ごとの目安と、AIが検索してきたものを、
// 同じ顔で並べてはいけません。現地で閉まっていたとき、どれを疑えば
// よかったのかが分からなくなります。
//
//   🟢 確認済み … 収録データの実測値、または経路検索で取れた値
//   🟡 推定    … 分類ごとの目安、距離からの計算
//   🟠 AI調査  … AIが検索して得たもの。現地で変わっている可能性あり
//
// 「それっぽい嘘」より「分かりません」のほうが価値がある、という
// このアプリの方針を、画面の上でも守るための仕組みです。

export const LEVELS = {
  verified:  { label: "確認済み", icon: "🟢", rank: 0,
               tone: "この情報は確認が取れています。",
               action: "" },
  estimated: { label: "推定",     icon: "🟡", rank: 1,
               tone: "実際と異なる場合があります。",
               action: "時間に余裕を持ってお出かけください。" },
  ai:        { label: "AI調査",   icon: "🟠", rank: 2,
               tone: "公式情報を確認できていません。",
               action: "訪問前に、公式サイトで営業時間をご確認ください。" },
};

const fmtDate = (ms) => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * その情報の確からしさ。
 *
 * @param {"hours"|"travel"|"fee"|"place"} kind 何についてか
 * @param {object} subject スポット、または移動の項目
 * @param {{now?:Date}} [opts]
 * @returns {{level:string, label:string, icon:string, text:string,
 *            checkedAt:string, ageText:string, stale:boolean}}
 */
export function confidenceOf(kind, subject, opts = {}) {
  const s = subject ?? {};
  const checkedAt = Number.isFinite(s.fetchedAt) ? fmtDate(s.fetchedAt) : "";
  const age = ageOf(s.fetchedAt, opts.now ?? new Date());

  if (kind === "travel") {
    const routed = s.routed === true;
    return build(routed ? "verified" : "estimated",
      routed
        ? (s.transit
            ? "経路検索で確認した所要時間です（乗換・待ち時間を含みます）"
            : "経路検索で確認した所要時間です")
        : "距離からの推定です。実際の便やダイヤは反映していません",
      checkedAt, age);
  }

  // 場所そのもの、営業時間、料金は、出どころが同じなので同じ判定です。
  if (s.source === "ai" || s.verified === false) {
    return build("ai",
      "AIが検索して得た情報です。現地で変わっている可能性があります",
      checkedAt, age);
  }
  const hasHours = s.hours?.open !== undefined || s.open !== undefined;
  if (kind === "hours") {
    return hasHours
      ? build("verified", "収録データで確認した営業時間です", checkedAt, age)
      : build("estimated", "分類ごとの目安です。実際の営業時間とは異なります",
              checkedAt, age);
  }
  if (kind === "fee") {
    const hasFee = s.hours?.fee !== undefined || s.fee !== undefined;
    return hasFee
      ? build("verified", "収録データの料金です", checkedAt, age)
      : build("estimated", "分類ごとの目安です", checkedAt, age);
  }
  return build("verified", "収録データです", checkedAt, age);
}

/** 情報が古いと見なす日数。営業時間は季節で変わります。 */
export const STALE_DAYS = 60;

/**
 * 「確認済み」と「最新」は、別のことです。
 *
 * 3年前に確認した営業時間も「確認済み」ではあります。けれど、
 * それを最新と同じ顔で出せば、閉まっている店の前に立たせることに
 * なります。確からしさ（どこから来たか）と、鮮度（いつ取ったか）は
 * 分けて出します。
 *
 * @returns {{text:string, level:"fresh"|"aging"|"stale"|"unknown"}}
 */
export function freshnessOf(fetchedAt, now = new Date()) {
  if (!Number.isFinite(fetchedAt)) {
    return { text: "確認日は不明です", level: "unknown" };
  }
  const days = Math.floor((now - fetchedAt) / 86400000);
  if (days < 0) return { text: "確認日は不明です", level: "unknown" };
  const when = days === 0 ? "今日" : days === 1 ? "昨日"
    : days < 31 ? `${days}日前`
    : `${Math.floor(days / 30)}か月前`;
  return {
    text: `最終確認 ${fmtDate(fetchedAt)}（${when}）`,
    level: days >= STALE_DAYS ? "stale" : days >= 30 ? "aging" : "fresh",
  };
}

/**
 * いつ取ったものかを、そのまま読める言葉に。
 * 分からないときは何も言いません（それらしい日付を作らないこと）。
 */
function ageOf(fetchedAt, now) {
  if (!Number.isFinite(fetchedAt)) return { text: "", stale: false, days: null };
  const days = Math.floor((now - fetchedAt) / 86400000);
  if (days < 0) return { text: "", stale: false, days: null };
  const text = days === 0 ? "今日取得"
    : days === 1 ? "昨日取得"
    : days < 31 ? `${days}日前に取得`
    : `${Math.floor(days / 30)}か月前に取得`;
  return { text, stale: days >= STALE_DAYS, days };
}

function build(level, text, checkedAt, age = { text: "", stale: false }) {
  const def = LEVELS[level];
  return { level, label: def.label, icon: def.icon, rank: def.rank,
           action: def.action,
           text: age.stale
             ? `${text}（${age.text}。変わっている可能性があります）`
             : text,
           checkedAt, ageText: age.text, stale: age.stale };
}

/**
 * いくつかの情報をまとめたときの、全体の確からしさ。
 *
 * いちばん弱いものが全体の弱さです。9件が確認済みでも、1件が
 * AI調査なら、その旅程は「AI調査が混じっている」と言うべきです。
 */
export function describeSource(list) {
  const items = (list ?? []).filter(Boolean);
  if (!items.length) {
    return build("estimated", "情報の出どころが分かりません", "");
  }
  const worst = items.slice().sort((a, b) => b.rank - a.rank)[0];
  const counts = {};
  for (const c of items) counts[c.level] = (counts[c.level] ?? 0) + 1;
  const parts = Object.entries(counts)
    .sort((a, b) => LEVELS[a[0]].rank - LEVELS[b[0]].rank)
    .map(([k, n]) => `${LEVELS[k].label} ${n}件`);
  const def = LEVELS[worst.level];
  return { ...worst,
           text: `${parts.join("・")}。${def.tone}`,
           action: def.action };
}


// --- 予約 -------------------------------------------------------------------

/**
 * 予約が要る分類。**「多い」であって「必ず」ではありません。**
 * 断定すると、要らない場所で予約を探させることになります。
 */
const OFTEN_RESERVED = {
  酒蔵: "見学は事前予約制のことが多い分類です",
  文化施設: "催しによっては事前予約が要ることがあります",
  テーマパーク: "日時指定の入場券が要ることがあります",
  水族館: "混雑期は日時指定の券が要ることがあります",
};

/**
 * その場所に予約が要るか。
 *
 * @returns {{required:boolean, likely:boolean, text:string, url:string}}
 */
export function reservationOf(spot) {
  const s = spot ?? {};
  const url = /^https:\/\//.test(s.reservationUrl ?? "") ? s.reservationUrl : "";
  if (s.reservationRequired === true) {
    return { required: true, likely: true, url,
      text: "事前予約が必要です。訪問前に公式でお申し込みください。" };
  }
  const hint = OFTEN_RESERVED[s.category];
  if (hint) {
    return { required: false, likely: true, url,
      text: `${hint}。訪問前に公式でご確認ください。` };
  }
  return { required: false, likely: false, url, text: "" };
}
