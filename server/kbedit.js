// 管理画面で決めたスポットの変更を、kb/ のファイルに当てます。
//
// Worker（GitHub に PR を出すとき）と tools/apply_kb_edits.mjs
// （手元で当てるとき）の両方から使います。ファイルの読み書きはせず、
// 中身（文字列）を受け取って、変わったものだけを返します。
//
// 書き出しは取り込みの道具（tools/*.py）と同じ詰めた JSON です
// （区切りに空白を入れない・日本語はそのまま）。差分が変更した行だけに
// なるようにするためです。

/** kb の JSON と同じ書きかた。 */
export function dump(obj) {
  return JSON.stringify(obj);
}

/** そのエリアが入っているシャード。 */
export function shardOf(index, regionId) {
  return (index.shards ?? []).find((s) => (s.regions ?? []).includes(regionId)) ?? null;
}

/** 変更が触るシャードのファイル名。 */
export function shardsFor(index, edits) {
  const files = new Set();
  for (const e of edits) {
    const sh = shardOf(index, e.op === "add" ? e.spot.regionId : e.regionId);
    if (sh) files.add(sh.file);
  }
  return [...files];
}

/**
 * 変更を当てます。
 *
 * @param {object} p
 * @param {string} p.index   kb/index.json の中身
 * @param {Map<string,string>} p.shards  ファイル名 → 中身（触るものだけ）
 * @param {string} [p.names] kb/names.json の中身（名前を足し引きするとき）
 * @param {object[]} p.edits 変更（server/stats.js の cleanEdit の形）
 * @returns {{ files: Map<string,string>, applied: object[], skipped: object[] }}
 */
export function applyEdits({ index, shards, names, edits }) {
  const idx = JSON.parse(index);
  const docs = new Map([...shards].map(([f, text]) => [f, JSON.parse(text)]));
  const applied = []; const skipped = [];
  const nameList = names ? JSON.parse(names).names.split("\n") : null;
  const touched = new Set();

  const locate = (id) => {
    for (const [file, doc] of docs) {
      const i = doc.spots.findIndex((s) => s.id === id);
      if (i >= 0) return { file, doc, i };
    }
    return null;
  };

  for (const e of edits) {
    if (e.op === "add") {
      const sh = shardOf(idx, e.spot.regionId);
      const doc = sh && docs.get(sh.file);
      if (!doc) { skipped.push({ ...e, why: "そのエリアの入るファイルが見つかりません" }); continue; }
      if (doc.spots.some((s) => s.id === e.spot.id)) {
        skipped.push({ ...e, why: "同じ id がすでにあります" }); continue;
      }
      doc.spots.push(e.spot);
      touched.add(sh.file);
      if (nameList && !nameList.includes(e.spot.name)) nameList.push(e.spot.name);
      applied.push(e);
      continue;
    }
    const at = locate(e.id);
    if (!at) { skipped.push({ ...e, why: "そのスポットが見つかりません" }); continue; }
    const spot = at.doc.spots[at.i];
    if (e.op === "delete") {
      at.doc.spots.splice(at.i, 1);
      if (nameList && e.dropName) {
        const k = nameList.indexOf(spot.name);
        if (k >= 0) nameList.splice(k, 1);
      }
    } else if (e.op === "category") {
      spot.category = e.category;
    } else if (e.op === "description") {
      if (e.description) spot.description = e.description;
      else delete spot.description;
    } else {
      skipped.push({ ...e, why: "知らない種類の変更です" }); continue;
    }
    touched.add(at.file);
    applied.push(e);
  }

  const files = new Map();
  let total = 0;
  for (const sh of idx.shards ?? []) {
    const doc = docs.get(sh.file);
    if (!doc || !touched.has(sh.file)) continue;
    sh.count = doc.spots.length;
    sh.regions = [...new Set(doc.spots.map((s) => s.regionId).filter(Boolean))].sort();
    files.set(`kb/${sh.file}`, dump(doc));
  }
  if (touched.size) {
    // 件数の合計は、触っていないシャードの申告と足して出します。
    for (const sh of idx.shards ?? []) total += sh.count ?? 0;
    if (idx.counts) idx.counts.spots = total;
    files.set("kb/index.json", dump(idx));
    if (nameList) files.set("kb/names.json", dump({ names: nameList.join("\n") }));
  }
  return { files, applied, skipped };
}
