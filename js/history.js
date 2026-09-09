// つくった旅程を覚えておく。
//
// 旅行サイトでいちばん使われるのは「前に作った旅程をもう一度開く」です。
// これまでは、条件の共有（URL）と印刷はできたのに、**過去に作ったものの
// 一覧がどこにもありませんでした**。ブラウザを閉じたら終わりです。
//
// 覚えるのは端末の中だけです。どこにも送りません。
//
// 何を覚えるか
// ------------
// 旅程そのもの（時刻の入った全部）ではなく、**作り直せるだけの条件**と、
// 一覧に出す見出しだけを持ちます。旅程は毎回組み直します。
//
//   ・営業時間も混雑も、日が変われば変わります。3か月前に作った旅程を
//     そのまま出すと、閉まっている場所へ案内することになります。
//   ・条件だけなら小さいので、10件持っても数十KBです。

const KEY = "tabisaki.history";
/** 覚えておく件数。多すぎると、探すほうが面倒になります。 */
export const MAX = 10;

function store(storage) {
  return storage ?? globalThis.localStorage ?? null;
}

/** 保存されている一覧。新しい順。 */
export function loadHistory(storage) {
  try {
    const raw = store(storage)?.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isValid) : [];
  } catch {
    return [];   // 壊れていたら、無かったことにします
  }
}

function isValid(item) {
  return Boolean(item && typeof item === "object"
    && typeof item.id === "string" && typeof item.title === "string");
}

/**
 * 1件足します。
 *
 * 同じ旅（同じ行き先・同じ日程）を何度も作り直すのはふつうのことです。
 * そのたびに一覧が埋まると、探せなくなります。**同じものは上書き**して、
 * いちばん上に持ってきます。
 *
 * @param {{title:string, subtitle?:string, when?:string, state:object}} entry
 * @returns {Array} 新しい一覧
 */
export function addHistory(entry, storage, now = new Date()) {
  if (!entry?.title || !entry?.state) return loadHistory(storage);
  const id = keyOf(entry);
  const item = {
    id,
    title: String(entry.title).slice(0, 60),
    subtitle: String(entry.subtitle ?? "").slice(0, 80),
    when: String(entry.when ?? "").slice(0, 40),
    savedAt: now.getTime(),
    state: entry.state,
  };
  const rest = loadHistory(storage).filter((x) => x.id !== id);
  const list = [item, ...rest].slice(0, MAX);
  write(list, storage);
  return list;
}

/**
 * 同じ旅かどうかの見分け。行き先・出発地・日程が同じなら同じ旅です。
 *
 * 名前は js/app.js の formState() と揃えてあります（from / to / dep / arr）。
 * ここがずれると、条件を変えたのに上書きされる・同じ旅が何件も並ぶ、の
 * どちらかが起きます。
 */
function keyOf(entry) {
  const s = entry.state ?? {};
  return [entry.title, s.from ?? "", s.to ?? "", s.dep ?? "", s.arr ?? ""]
    .join("|");
}

export function removeHistory(id, storage) {
  const list = loadHistory(storage).filter((x) => x.id !== id);
  write(list, storage);
  return list;
}

export function clearHistory(storage) {
  write([], storage);
  return [];
}

function write(list, storage) {
  try {
    store(storage)?.setItem(KEY, JSON.stringify(list));
  } catch { /* 保存できなくても、旅程は作れます */ }
}

/**
 * 「3日前」「9月5日」のような、一覧に出す言葉。
 *
 * 時刻までは出しません。一覧で知りたいのは「いつごろ作ったか」で、
 * 何時何分に作ったかではありません。
 */
export function savedLabel(savedAt, now = new Date()) {
  if (!Number.isFinite(savedAt)) return "";
  const days = Math.floor((now - savedAt) / 86400000);
  if (days <= 0) return "今日";
  if (days === 1) return "昨日";
  if (days < 7) return `${days}日前`;
  const d = new Date(savedAt);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
