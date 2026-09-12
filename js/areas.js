// 希望文に出てくる地名を拾う。
//
// 「四国の有名な観光地を巡りたい」と書いたのに銚子が出てくる——
// 語句検索では「四国」がどのスポット名にも含まれないので、一致ゼロになり、
// 何でもいいから返す経路に落ちていました。地名は他の検索語とは性質が
// 違います。ジャンルは「近いもの」で代用できますが、地名は代用できません。
//
// そこで地名だけを先に取り出し、
//   ・収録があれば、その範囲に絞ってから選ぶ
//   ・収録が無ければ、提案の前に「収録が無い」とはっきり言う
// の2つに分けます。黙って別の場所を出すのがいちばん困ります。

import { wordRuns } from "./keywords.js";
import { withJapanesePlaces } from "./romaji.js";

/** 地方名 → 都道府県。 */
export const MACRO_AREAS = {
  北海道: ["北海道"],
  東北: ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"],
  関東: ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"],
  首都圏: ["東京都", "神奈川県", "埼玉県", "千葉県"],
  中部: ["新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
         "岐阜県", "静岡県", "愛知県"],
  北陸: ["新潟県", "富山県", "石川県", "福井県"],
  甲信越: ["山梨県", "長野県", "新潟県"],
  東海: ["岐阜県", "静岡県", "愛知県", "三重県"],
  近畿: ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"],
  関西: ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"],
  中国地方: ["鳥取県", "島根県", "岡山県", "広島県", "山口県"],
  山陰: ["鳥取県", "島根県"],
  山陽: ["岡山県", "広島県", "山口県"],
  四国: ["徳島県", "香川県", "愛媛県", "高知県"],
  九州: ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県"],
  沖縄: ["沖縄県"],
  瀬戸内: ["香川県", "愛媛県", "岡山県", "広島県", "兵庫県"],
};

/**
 * 決まった言い回し。
 *
 * 「3大都市の美術館をめぐりたい」と書いても、「3大都市」という語は
 * どのスポット名にも入っていません。一致ゼロのまま点の高い順に選ぶので、
 * 鹿児島市・京都市・箱根のような並びが出ていました。**日本語として
 * 分かっている言葉は、分かっているものとして扱います。**
 *
 * ここに入れるのは、指す先が決まっているものだけです。「絶景」や
 * 「映え」のような、人によって指す先が変わる言葉は入れません。
 */
export const NAMED_SETS = {
  三大都市: ["東京", "大阪", "名古屋"],
  "3大都市": ["東京", "大阪", "名古屋"],
  三大都市圏: ["東京", "大阪", "名古屋"],
  五大都市: ["東京", "大阪", "名古屋", "横浜", "京都"],
  大都市: ["東京", "大阪", "名古屋", "横浜", "札幌", "福岡"],
  日本三景: ["松島", "天橋立", "宮島"],
  三名園: ["金沢", "岡山", "水戸"],
  日本三名園: ["金沢", "岡山", "水戸"],
  三名泉: ["草津", "下呂", "有馬"],
  日本三名泉: ["草津", "下呂", "有馬"],
  三古湯: ["道後", "有馬", "白浜"],
  三大祭: ["京都", "大阪", "東京"],
};

export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

/** 「京都」のように県名を省いた書き方。長い順に見るので誤爆しません。 */
const SHORT_PREF = PREFECTURES
  .filter((p) => p !== "北海道")
  .map((p) => [p.replace(/[都道府県]$/, ""), p]);

/**
 * 文中の地名を拾います。
 * @returns {Array<{term:string, kind:"macro"|"prefecture"|"region",
 *                  prefectures:string[], regionIds:string[]}>}
 */
export function detectAreas(text, kb) {
  // ローマ字で書かれた地名を、収録の表記に足してから探します。
  //
  // 「I want to visit around Sendai」と書かれて、**旭川市・函館市**が
  // 出ていました。仙台から700km離れています。ここは収録の名前
  // （「仙台市」）をそのまま探すので、"Sendai" はどこにも一致せず、
  // 地名の指定が無かったことになって、点の高い順に返っていました。
  const s = withJapanesePlaces(text);
  if (!s.trim()) return [];
  const found = [];
  const seen = new Set();

  const push = (term, kind, prefectures, regionIds, groups = null) => {
    if (seen.has(term)) return;
    seen.add(term);
    found.push({ term, kind, prefectures, regionIds, groups });
  };

  // 収録エリア名（「箱根」「道後」など）がいちばん具体的なので先に見る
  for (const r of kb?.regions ?? []) {
    for (const name of [r.name, ...String(r.name).split(/[・]/)]) {
      if (name.length >= 2 && s.includes(name)) {
        push(name, "region", [r.prefecture], [r.id]);
        break;
      }
    }
  }
  // 決まった言い回し（「3大都市」「日本三景」）は、指す先が決まっています。
  // 広い地方名より先に見ます。「三大都市」を「都市」の一般語として
  // 扱うと、結局は点の高い順に戻ってしまいます。
  // 長い言い回しから順に見ます。「3大都市」を拾ったあとで「大都市」も
  // 拾うと、6エリアの指定が13エリアに広がって、指定した意味が消えます。
  const namedHits = [];
  for (const [term, names] of Object.entries(NAMED_SETS)
    .sort((a, b) => b[0].length - a[0].length)) {
    if (!s.includes(term)) continue;
    if (namedHits.some((t) => t.includes(term))) continue;
    namedHits.push(term);
    const ids = [];
    const prefs = new Set();
    // どのエリアが、どの地名（東京・大阪・名古屋）に属するか。
    // 「3大都市」は3つとも回るのが自然なので、あとで1つずつ選びます。
    const groups = new Map();
    for (const name of names) {
      for (const r of kb?.regions ?? []) {
        if (r.name.includes(name) || name.includes(r.name)) {
          ids.push(r.id);
          groups.set(r.id, name);
          if (r.prefecture) prefs.add(r.prefecture);
        }
      }
    }
    if (ids.length) push(term, "region", [...prefs], ids, groups);
  }
  for (const [term, prefs] of Object.entries(MACRO_AREAS)) {
    if (s.includes(term)) push(term, "macro", prefs, regionsIn(kb, prefs));
  }
  for (const p of PREFECTURES) {
    if (s.includes(p)) push(p, "prefecture", [p], regionsIn(kb, [p]));
  }
  for (const [short, full] of SHORT_PREF) {
    if (short.length >= 2 && s.includes(short)) {
      push(full, "prefecture", [full], regionsIn(kb, [full]));
    }
  }
  return found;
}

function regionsIn(kb, prefectures) {
  const set = new Set(prefectures);
  return (kb?.regions ?? []).filter((r) => set.has(r.prefecture)).map((r) => r.id);
}

/**
 * 拾った地名から、絞り込みに使う地域IDと、収録が無かった地名を分けます。
 *
 * @returns {{regionIds:Set<string>|null, matched:Array, missing:Array}}
 *   regionIds が null なら「地名の指定なし」＝絞り込みません。
 */
export function areaScope(areas) {
  if (!areas.length) return { regionIds: null, matched: [], missing: [] };
  const matched = areas.filter((a) => a.regionIds.length);
  const missing = areas.filter((a) => !a.regionIds.length);
  if (!matched.length) return { regionIds: null, matched, missing };
  const ids = new Set();
  // 「3大都市」のように、複数の地名を並べた言い方のときは、その内訳も
  // 返します。1つの街に固まらず、名指しされた街を1つずつ回るためです。
  const groupById = new Map();
  for (const a of matched) {
    for (const id of a.regionIds) ids.add(id);
    if (a.groups) for (const [id, name] of a.groups) groupById.set(id, name);
  }
  return { regionIds: ids, matched, missing,
           groupById: groupById.size ? groupById : null };
}

/**
 * 地名についての説明文。応えられた場合も、応えられなかった場合も言います。
 */
export function areaNote(scope, { chosenRegionName, unknownTerms = [] } = {}) {
  const notes = [];
  const missing = [...scope.missing.map((a) => a.term), ...unknownTerms];
  if (missing.length) {
    const names = [...new Set(missing)].join("・");
    notes.push(`「${names}」は現在このアプリに収録がありません。`
      + "収録済みのエリアから、ご希望に近いものを提案しています。");
  }
  if (scope.matched.length && chosenRegionName) {
    const names = mostSpecific(scope.matched).map((a) => a.term).join("・");
    notes.push(`「${names}」の収録エリアの中から${chosenRegionName}を選びました。`);
  }
  return notes;
}

// 「屋久島に行きたい」——地名だけれど収録が無い、を言えるようにする。
//
// 地名の辞書を持って照合する方法は、抜けたぶんだけ黙って別の場所に
// すり替わるので採りません。代わりに「地名の形をしていて、収録データの
// どこにも現れない語」を探します。出てこない理由を言えることが大事で、
// 何を知らないかを網羅することは目的ではありません。
const PLACE_SUFFIX = /(島|山|岳|丘|砂丘|川|湖|沼|岬|崎|温泉|寺|神社|宮|城|園|峠|渓|滝|浜|浦|坂|橋|塔|宿|村|町|市|郡|県|府|地方|高原|海岸|渓谷|半島|平野|盆地|遺跡|城跡)$/;

/**
 * 地名として使われそうにないカタカナ語。
 * これを除かないと「カフェ」「ホテル」まで地名候補になります。
 */
const NOT_PLACE = new Set([
  "カフェ", "ホテル", "スパ", "サウナ", "アート", "グルメ", "ランチ",
  "ディナー", "ショッピング", "レストラン", "バス", "タクシー", "ツアー",
  "ロープウェイ", "スイーツ", "ビーチ", "パノラマ", "ミュージアム",
  "テーマパーク", "ハイキング", "リゾート", "ドライブ", "サイクリング",
  "キャンプ", "グランピング", "ダイビング", "シュノーケリング", "スキー",
  "スノーボード", "ゆっくり", "のんびり",
]);

export function unknownPlaceTerms(text, kb) {
  // ここも同じです。読み替えれば分かる地名を「知らない場所」として
  // 報告すると、断り文句だけが出て旅程が組めません。
  text = withJapanesePlaces(text);
  const s = String(text ?? "");
  if (!s.trim() || !kb?.spots?.length) return [];
  const haystack = kb.__searchHaystack ?? (kb.__searchHaystack = [
    ...kb.spots.map((x) => `${x.name} ${x.region} ${x.prefecture} ${x.category} ${x.description ?? ""}`),
    ...kb.regions.map((r) => `${r.name} ${r.prefecture} ${r.station ?? ""} ${r.description ?? ""}`),
  ].join("\n"));

  const out = [];
  for (const term of new Set(wordRuns(s))) {
    if (term.length < 3 && !PLACE_SUFFIX.test(term)) continue;
    if (!PLACE_SUFFIX.test(term)) continue;
    if (haystack.includes(term)) continue;
    if (MACRO_AREAS[term]) continue;
    out.push(term);
  }

  // カタカナの地名（「パリ」「ハワイ」「ウユニ」）。
  //
  // wordRuns はカタカナを3文字以上でしか拾いません（「ーバ」のような
  // 断片で誤検索した過去があるため）。地名の判定はそれとは別の用途なので、
  // 2文字から拾い、収録に無く、地名らしくない語でもないものを候補にします。
  // これが無いと、キーが無いときに「パリ」が黙って別の土地に化けます。
  for (const m of s.matchAll(/[ァ-ヶー]{2,}/g)) {
    const term = m[0];
    if (term.length < 2 || NOT_PLACE.has(term)) continue;
    if (haystack.includes(term)) continue;
    if (out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

/**
 * 「京都・京都府」のように、同じ場所を指す語が並ぶのを避けます。
 * 広いほう（他方を丸ごと含むほう）を落として、具体的なほうを残します。
 */
export function mostSpecific(areas) {
  return areas.filter((a) => !areas.some((b) => {
    if (a === b || b.regionIds.length >= a.regionIds.length) return false;
    return b.regionIds.every((id) => a.regionIds.includes(id));
  }));
}

/**
 * 都道府県のおおよその中心と、そこからの許容半径（km）。
 *
 * AI に観光地を調べさせるとき、「愛媛県」と言いながら関東の座標を返す、
 * といった取り違えが起きます。名前と座標が食い違っていないかを機械的に
 * 確かめるための、粗い物差しです。厳密な境界は要りません。
 * 離島を抱える都県は半径を広く取っています（東京都の小笠原など）。
 */
export const PREF_CENTER = {
  北海道: [43.064, 141.347, 500], 青森県: [40.824, 140.740, 130],
  岩手県: [39.704, 141.153, 140], 宮城県: [38.269, 140.872, 120],
  秋田県: [39.719, 140.102, 140], 山形県: [38.240, 140.363, 130],
  福島県: [37.750, 140.468, 150], 茨城県: [36.342, 140.447, 120],
  栃木県: [36.566, 139.884, 110], 群馬県: [36.391, 139.060, 110],
  埼玉県: [35.857, 139.649, 110], 千葉県: [35.605, 140.123, 120],
  東京都: [35.690, 139.692, 1100], 神奈川県: [35.448, 139.643, 100],
  新潟県: [37.902, 139.023, 220], 富山県: [36.695, 137.211, 100],
  石川県: [36.595, 136.626, 140], 福井県: [36.065, 136.222, 120],
  山梨県: [35.664, 138.568, 100], 長野県: [36.651, 138.181, 160],
  岐阜県: [35.391, 136.722, 140], 静岡県: [34.977, 138.383, 150],
  愛知県: [35.180, 136.907, 110], 三重県: [34.730, 136.509, 140],
  滋賀県: [35.005, 135.869, 90], 京都府: [35.021, 135.756, 130],
  大阪府: [34.686, 135.520, 90], 兵庫県: [34.691, 135.183, 160],
  奈良県: [34.685, 135.833, 110], 和歌山県: [34.226, 135.167, 120],
  鳥取県: [35.504, 134.238, 120], 島根県: [35.472, 133.051, 220],
  岡山県: [34.662, 133.935, 110], 広島県: [34.396, 132.460, 130],
  山口県: [34.186, 131.471, 130], 徳島県: [34.066, 134.559, 110],
  香川県: [34.340, 134.043, 90], 愛媛県: [33.842, 132.766, 130],
  高知県: [33.560, 133.531, 150], 福岡県: [33.607, 130.418, 120],
  佐賀県: [33.249, 130.300, 90], 長崎県: [32.745, 129.874, 230],
  熊本県: [32.790, 130.742, 150], 大分県: [33.238, 131.613, 120],
  宮崎県: [31.911, 131.424, 140], 鹿児島県: [31.560, 130.558, 320],
  沖縄県: [26.212, 127.681, 500],
};

/** 日本の範囲。ここを外れた座標は、名前が何であれ採用しません。 */
export const JAPAN_BOUNDS = { minLat: 20.2, maxLat: 45.8, minLng: 122.8, maxLng: 154.1 };
