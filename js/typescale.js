// 字の大きさを、その端末で決められるようにする。
//
// なぜ要るか
// ----------
// 字の大きさは rem で書いてあり、根（:root）の大きさについていきます。
// そして根は2通りで動きます。
//
//   ・ブラウザの既定の字（パソコンの「フォントサイズ」設定、携帯の
//     「最小フォントサイズ」、ページの拡大）
//   ・iOS の Dynamic Type（font: -apple-system-body で直結。
//     css/hig.css の @supports）
//
// これで多くの場合は届きますが、**Android の Chrome では2つ目が
// 効きません**。OSの「文字サイズ」を上げても、`-apple-system-body`
// を解釈しないので根は16pxのままです。設定の場所を知らない人、
// ブラウザの設定に触りたくない人もいます。
//
// そこで倍率を1つ持ちます。CSSは calc(100% * var(--hig-type-scale))
// で根を出しているので、この値を書き換えれば全部の字が動きます。
// OSの設定と**掛け算**になるので、iOSで20pxになっていればその1.2倍です。
//
// 保存先について
// --------------
// APIキーとは別の鍵に置きます。設定を消すのは「キーを config.js に
// 戻す」という意味なので、そこに字の大きさを混ぜると、キーを消した
// 人の字まで元に戻ります。別のことなので、別に持ちます。

/** 保存する鍵。キーの設定（tabisaki.settings）とは別にします。 */
export const TYPE_SCALE_KEY = "tabisaki.typeScale";

/**
 * 選べる段。
 *
 * 刻みは 1 → 1.15 → 1.3 → 1.5 です。細かく刻んでも選び分けられない
 * ので、4段にしてあります。1.5倍だと本文は 25.5px になり、iOS の
 * 「文字を大きく」のいちばん上あたりです。
 *
 * これより上（アクセシビリティサイズ）は、OSの設定に任せます。
 * 掛け算になるので、両方上げればそこまで行けます。
 */
export const TYPE_SCALES = [
  { value: 1, label: "標準" },
  { value: 1.15, label: "やや大きい" },
  { value: 1.3, label: "大きい" },
  { value: 1.5, label: "特大" },
];

const MIN = 1;
const MAX = 2;

function store(storage) {
  return storage ?? globalThis.localStorage ?? null;
}

/**
 * 保存してある倍率。読めなければ 1（標準）。
 *
 * 壊れた値（0、負、文字）で画面が読めなくなるのを防ぐため、
 * 1〜2 に収めます。0 を入れられると字が消えます。
 */
export function loadTypeScale(storage) {
  try {
    const raw = store(storage)?.getItem(TYPE_SCALE_KEY);
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX, Math.max(MIN, n));
  } catch {
    // 非公開ウィンドウ・保存を切っている環境。標準で動きます。
    return 1;
  }
}

/** 倍率を保存します。標準（1）なら鍵ごと消します。 */
export function saveTypeScale(scale, storage) {
  const n = Math.min(MAX, Math.max(MIN, Number(scale) || 1));
  try {
    const s = store(storage);
    if (!s) return n;
    if (n === 1) s.removeItem(TYPE_SCALE_KEY);
    else s.setItem(TYPE_SCALE_KEY, String(n));
  } catch { /* 保存できなくても、この場では効きます */ }
  return n;
}

/**
 * 倍率を画面に当てます。
 *
 * @param {number} scale
 * @param {HTMLElement} [root] 試験用の差し替え口
 */
export function applyTypeScale(scale, root) {
  const el = root ?? globalThis.document?.documentElement;
  if (!el?.style) return;
  const n = Math.min(MAX, Math.max(MIN, Number(scale) || 1));
  el.style.setProperty("--hig-type-scale", String(n));
}

/**
 * 起動時に1回。保存してある倍率を当てます。
 *
 * **画面を組む前に呼びます。** あとから当てると、標準の大きさで
 * 一度描いてから大きくなるので、字が飛び跳ねて見えます。
 *
 * @returns {number} 当てた倍率
 */
export function initTypeScale(storage, root) {
  const n = loadTypeScale(storage);
  applyTypeScale(n, root);
  return n;
}
