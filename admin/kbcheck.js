// 収録データ（kb/）の点検。画面に依存しない関数だけを置きます（tests/admin-kbcheck.test.js）。
//
// 入力は kb/ のシャードをそのまま読んだもの { index, regions, spots }。
// spots の各要素には、どのファイルから来たか（_file）が付きます。

/** 日本の本土・島のおおよその範囲。ここを外れたら座標の取り違えを疑います。 */
export const JAPAN_BOX = Object.freeze({ latMin: 20, latMax: 46.5, lngMin: 122, lngMax: 154.5 });

const STALE_DAYS = 60;
const TIER_WEIGHT = { major: 3, known: 2, hidden: 1 };

/** 構造の点検。見つけたものを { level, title, detail, ids } の並びで返します。 */
export function integrity({ index, regions, spots }) {
  const issues = [];
  const add = (level, title, detail, ids = []) => issues.push({ level, title, detail, ids: ids.slice(0, 50), n: ids.length });

  // 申告と実数
  const declared = index?.counts?.spots;
  if (Number.isFinite(declared) && declared !== spots.length) {
    add("ng", "index.json の件数が実数と違う", `申告 ${declared.toLocaleString()} / 実際 ${spots.length.toLocaleString()}`);
  }
  const byFile = new Map();
  for (const s of spots) byFile.set(s._file, (byFile.get(s._file) ?? 0) + 1);
  const off = (index?.shards ?? []).filter((sh) => (byFile.get(sh.file) ?? 0) !== sh.count);
  if (off.length) {
    add("ng", "シャードの件数が申告と違う",
      off.map((sh) => `${sh.file}: 申告 ${sh.count} / 実際 ${byFile.get(sh.file) ?? 0}`).join("、"),
      off.map((sh) => sh.file));
  }

  // 重複
  const seen = new Map(); const dupIds = new Set();
  for (const s of spots) {
    if (seen.has(s.id)) dupIds.add(s.id); else seen.set(s.id, s);
  }
  if (dupIds.size) add("ng", "id の重複", "同じ id が複数あると、片方が黙って消えます", [...dupIds]);

  const byName = new Map();
  for (const s of spots) {
    const k = `${s.regionId}\u0000${s.name}`;
    (byName.get(k) ?? byName.set(k, []).get(k)).push(s.id);
  }
  const dupNames = [...byName.values()].filter((v) => v.length > 1);
  if (dupNames.length) {
    add("warn", "同じエリアに同じ名前", `${dupNames.length}組。重複を疑います`, dupNames.map((v) => v.join(" / ")));
  }

  // 参照
  const regionIds = new Set((regions ?? []).map((r) => r.id));
  const orphans = spots.filter((s) => !regionIds.has(s.regionId));
  if (orphans.length) add("ng", "存在しないエリアを指している", "regions.json に無い regionId", orphans.map((s) => s.id));
  const used = new Set(spots.map((s) => s.regionId));
  const empty = (regions ?? []).filter((r) => !used.has(r.id));
  if (empty.length) add("warn", "スポットが1件も無いエリア", `${empty.length}件`, empty.map((r) => r.id));

  // 欠け・範囲
  const missing = spots.filter((s) => !s.name || !s.category || !s.id);
  if (missing.length) add("ng", "名前・分類・id の欠け", "", missing.map((s) => s.id));
  const B = JAPAN_BOX;
  const away = spots.filter((s) => !(s.lat >= B.latMin && s.lat <= B.latMax && s.lng >= B.lngMin && s.lng <= B.lngMax));
  if (away.length) add("ng", "座標が日本の範囲の外", "緯度と経度の取り違えかもしれません", away.map((s) => s.id));
  const zero = spots.filter((s) => Number(s.lat) === 0 || Number(s.lng) === 0);
  if (zero.length) add("ng", "座標が 0", "", zero.map((s) => s.id));

  return issues;
}

/** 名前の終わりから見た、ふつうの分類。上から順に当てます。 */
export const NAME_RULES = [
  [/(神社|神宮|大社|八幡宮|天満宮|稲荷|宮)$/, "神社"],
  [/(寺|寺院|大仏|観音)$/, "寺院"],
  [/美術館$/, "美術館"],
  [/(博物館|資料館|記念館|科学館|郷土館)$/, "博物館"],
  [/(温泉|温泉郷|の湯)$/, "温泉"],
  [/(公園|庭園)$/, "公園"],
  [/(城|城跡|城址)$/, "城"],
  [/ダム$/, "ダム"],
];

/** 許す別名（名前の終わりが決める分類と、実際の分類が違っても誤りとは言わないもの）。 */
const ALSO_OK = {
  神社: ["史跡", "観光名所"], 寺院: ["史跡", "観光名所"], 公園: ["観光名所", "史跡"],
  城: ["史跡", "観光名所", "公園"], 博物館: ["美術館", "観光名所"], 美術館: ["博物館", "観光名所"],
  温泉: ["観光名所"], ダム: ["観光名所"],
};

/** 分類の誤りらしいもの。 { id, name, from, to, regionId } の並び。 */
export function misclassified(spots) {
  const out = [];
  for (const s of spots) {
    const name = String(s.name ?? "");
    for (const [re, want] of NAME_RULES) {
      if (!re.test(name)) continue;
      if (s.category !== want && !(ALSO_OK[want] ?? []).includes(s.category)) {
        out.push({ id: s.id, name, from: s.category, to: want, regionId: s.regionId });
      }
      break;
    }
  }
  return out;
}

/** 「A → B」ごとの件数。 */
export function misclassifiedGroups(list) {
  const m = new Map();
  for (const x of list) {
    const k = `${x.from} → ${x.to}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
}

/**
 * 確かめていない・古いスポット。
 * fetchedAt があれば古さで、無ければ「確認日が無い」として、有名なものから並べます。
 */
export function unverified(spots, { now = Date.now(), limit = 200 } = {}) {
  const scored = [];
  let stale = 0; let unknown = 0;
  for (const s of spots) {
    const has = Number.isFinite(s.fetchedAt);
    const days = has ? Math.floor((now - s.fetchedAt) / 86400000) : null;
    if (has && days < STALE_DAYS) continue;
    has ? stale++ : unknown++;
    const w = (TIER_WEIGHT[s.fame_tier] ?? 1) * 10 + (s.description ? 0 : 3) + (has ? Math.min(5, days / STALE_DAYS) : 5);
    scored.push({ w, id: s.id, name: s.name, regionId: s.regionId, category: s.category,
                  tier: s.fame_tier ?? "", days, hasDescription: Boolean(s.description) });
  }
  scored.sort((a, b) => b.w - a.w);
  return { total: stale + unknown, stale, unknown, top: scored.slice(0, limit) };
}

const ADDRESS_LIKE = /^(大字|字|[^\s。]{1,8}[町村市区郡][^\s。]{0,10}\d|[^\s。]*\d+(-|－|番地|丁目)\d*)/;

/** 穴場（hidden）の説明文の質。 */
export function hiddenQuality(spots, { minLength = 14, limit = 200 } = {}) {
  const hidden = spots.filter((s) => s.fame_tier === "hidden");
  const counts = new Map();
  for (const s of hidden) if (s.description) counts.set(s.description, (counts.get(s.description) ?? 0) + 1);
  const rows = []; const tally = { none: 0, short: 0, address: 0, repeated: 0, ok: 0 };
  for (const s of hidden) {
    const d = String(s.description ?? "").trim();
    let why = "";
    if (!d) why = "none";
    else if (ADDRESS_LIKE.test(d) && !/[。、]/.test(d)) why = "address";
    else if (d.length < minLength) why = "short";
    else if ((counts.get(s.description) ?? 0) >= 3) why = "repeated";
    tally[why || "ok"]++;
    if (why) rows.push({ id: s.id, name: s.name, regionId: s.regionId, category: s.category, description: d, why });
  }
  return { total: hidden.length, tally, rows: rows.slice(0, limit) };
}

export const WHY_LABEL = {
  none: "説明が無い", short: "短すぎる", address: "住所だけ", repeated: "同じ文が何か所にも",
};

/** 検索（名前の部分一致）。 */
export function search(spots, q, limit = 50) {
  const needle = String(q ?? "").trim();
  if (!needle) return [];
  const out = [];
  for (const s of spots) {
    if (String(s.name).includes(needle) || s.id === needle) {
      out.push(s);
      if (out.length >= limit) break;
    }
  }
  return out;
}
