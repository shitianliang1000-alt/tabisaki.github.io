// 旅程を読み進めると、地図の印もついてくる。
//
// 広い画面では、地図を旅程の横に固定しています（css/app.css）。
// 横にあるだけでは、いま読んでいる行が地図のどれなのかを、毎回
// 番号で探すことになります。読んでいる行の印を地図の側で濃くします。
//
// 「読んでいる行」は、画面の上から3分の1の線にかかっている立ち寄り
// です。いちばん上に見えている行だと、半分以上が画面の外へ出ていても
// 選ばれてしまいます。

/**
 * いま読んでいる行を選ぶ。純粋関数です（試験できるように）。
 *
 * @param {{id:string, top:number, bottom:number}[]} rows 画面の座標
 * @param {number} viewTop    見えている範囲の上端
 * @param {number} viewBottom 見えている範囲の下端
 * @returns {string|null}
 */
export function readingRow(rows, viewTop, viewBottom) {
  const line = viewTop + (viewBottom - viewTop) / 3;
  let best = null;
  let bestGap = Infinity;
  for (const r of rows ?? []) {
    if (!r?.id || r.bottom <= viewTop || r.top >= viewBottom) continue;
    if (r.top <= line && r.bottom >= line) return r.id;
    const gap = Math.min(Math.abs(r.top - line), Math.abs(r.bottom - line));
    if (gap < bestGap) { bestGap = gap; best = r.id; }
  }
  return best;
}

/**
 * 読み進めに合わせて onChange(spotId) を呼びます。止めるときは
 * 返した関数を呼びます。
 *
 * @param {HTMLElement} scroller スクロールする箱
 * @param {() => Iterable<HTMLElement>} rowsOf  立ち寄りの行（data-spot を持つ）
 * @param {(id:string|null) => void} onChange
 */
export function followReading(scroller, rowsOf, onChange) {
  if (!scroller) return () => {};
  let last;
  let queued = false;
  const tick = () => {
    queued = false;
    const box = scroller.getBoundingClientRect();
    const rows = [...rowsOf()].map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.dataset.spot, top: r.top, bottom: r.bottom };
    });
    const id = readingRow(rows, box.top, box.bottom);
    if (id !== last) { last = id; onChange(id); }
  };
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(tick);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  tick();
  return () => scroller.removeEventListener("scroll", onScroll);
}
