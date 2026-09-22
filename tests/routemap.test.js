// 圏外で出す順路の図。
//
// ここで確かめたいのは形の美しさではありません。**この図は地図に似て
// いて、地図ではない**ので、そう読まれない作りになっているかを見ます。
// 道が描かれていない図を地図として読んだ人は、道のないところへ歩きます。
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { groupByDay, projector, routeSvg, routeDiagram, scaleStep }
  from "../js/routemap.js";

const source = fs.readFileSync(new URL("../js/routemap.js", import.meta.url),
                               "utf8");

/**
 * document の代わり。routeSvg は createElementNS で SVG を作るので、
 * 素の Node には無いものが要ります（tests/icons.test.js と同じ作り）。
 */
function fakeDocument() {
  const make = (ns, tag) => ({
    ns, tag, attrs: new Map(), children: [], textContent: "",
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    append(...kids) {
      for (const k of kids) {
        this.children.push(k);
        this.textContent += typeof k === "string" ? k : (k.textContent ?? "");
      }
    },
  });
  return {
    createElementNS: (ns, tag) => make(ns, tag),
    createTextNode: (t) => String(t),
  };
}

/** 偽の document を敷いてから呼びます。 */
function withDom(fn) {
  const had = Object.hasOwn(globalThis, "document");
  const before = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    return fn();
  } finally {
    if (had) globalThis.document = before;
    else delete globalThis.document;
  }
}

/** 試験の中だけの、小さな el()。ui.js を持ち込まずに済ませます。 */
function el(tag, attrs = {}, ...kids) {
  const node = { tag, attrs, kids: [], text: "" };
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === "string") { node.text += c; node.kids.push(c); }
    else node.kids.push(c);
  }
  return node;
}

const KYOTO = [
  { lat: 34.9671, lng: 135.7727, label: "京都駅", kind: "origin" },
  { lat: 34.9949, lng: 135.7850, label: "清水寺", kind: "spot", order: 1,
    time: "10:00" },
  { lat: 35.0394, lng: 135.7292, label: "金閣寺", kind: "spot", order: 2,
    time: "13:30" },
  { lat: 34.9671, lng: 135.7727, label: "京都駅", kind: "end" },
];

test("東西を、緯度のぶんだけ縮める", () => {
  // 経度1度の長さは、緯度が上がるほど短くなります。日本（北緯35度）
  // では111kmではなく91kmです。縮めずに描くと、**東西に伸びた図**に
  // なり、「思ったより近い/遠い」の見当が狂います。
  const p = projector([{ lat: 35, lng: 139 }, { lat: 36, lng: 140 }],
                      640, 420);
  const a = p.xy({ lat: 36, lng: 139 });
  const b = p.xy({ lat: 35, lng: 140 });
  const wide = Math.abs(b.x - a.x);
  const tall = Math.abs(b.y - a.y);
  const ratio = wide / tall;
  // cos(35.5°) ≒ 0.814
  assert.ok(ratio > 0.78 && ratio < 0.85,
    `東西と南北の比が ${ratio.toFixed(3)} です（0.81 のはず）`);
});

test("枠に合わせて引き伸ばさない（同じ10kmが、縦と横で同じ長さ）", () => {
  // 片方に合わせて伸ばすと、縮尺の棒が意味を失います。
  const p = projector([{ lat: 35, lng: 139 }, { lat: 35.1, lng: 139.5 }],
                      640, 200);
  const dy = p.xy({ lat: 35, lng: 139 }).y - p.xy({ lat: 35.1, lng: 139 }).y;
  const dx = p.xy({ lat: 35, lng: 139.5 }).x - p.xy({ lat: 35, lng: 139 }).x;
  // 0.1度の緯度 ≒ 11.1km、0.5度の経度（北緯35度）≒ 45.6km
  const kmPerPxY = 11.132 / dy;
  const kmPerPxX = 45.57 / dx;
  assert.ok(Math.abs(kmPerPxX - kmPerPxY) / kmPerPxY < 0.02,
    `縦 ${kmPerPxY.toFixed(3)}km/px と横 ${kmPerPxX.toFixed(3)}km/px が`
    + "違います");
});

test("1か所だけでも、幅0で割らない", () => {
  const p = projector([{ lat: 35, lng: 139 }], 640, 420);
  const q = p.xy({ lat: 35, lng: 139 });
  assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y),
    `1点のときに ${JSON.stringify(q)} が出ています`);
  assert.ok(Number.isFinite(p.kmPerPx));
});

test("縮尺は、読める数に丸める", () => {
  // 「1.37km」と書いても、目で当てるときに使えません。
  for (const kmPerPx of [0.002, 0.05, 0.31, 2, 17]) {
    const step = scaleStep(kmPerPx, 120);
    // 0.2 も 200 も「2」です。位を外して先頭の数字だけを見ます。
    const digits = step.toExponential().split("e")[0].replace(/[.]0*$/, "");
    assert.ok(["1", "2", "5"].includes(digits),
      `${kmPerPx}km/px で ${step}km という棒が出ています`);
    assert.ok(step / kmPerPx <= 120,
      `棒が枠(120px)より長いです（${(step / kmPerPx).toFixed(0)}px）`);
  }
});

test("点が無いときは、空の図を出さない", () => withDom(() => {
  assert.equal(routeSvg([]), null);
  assert.equal(routeSvg(undefined), null);
  // 座標の無い行が混ざっていても落ちないこと。
  assert.equal(routeSvg([{ label: "どこか", kind: "spot" }]), null);
}));

test("道を描いたふりをしない", () => {
  // 図には線が引かれますが、それは順番です。道・線路・海岸線は
  // 持っていないので描きません。描いていないことを、図の中で言います。
  assert.match(source, /これは地図ではありません/);
  assert.match(source, /道は描いていません/);
  assert.match(source, /消さないでください/);
  // 道や地形を描こうとしていないこと。
  assert.ok(!/coastline|road|railway|道路|海岸線を描/.test(source),
    "道や地形を描こうとしています（持っていません）");
});

test("読み方の一文が、図に必ず付く", () => withDom(() => {
  const fig = routeDiagram(KYOTO, { el, heading: "順路" });
  assert.ok(fig, "図が作られていません");
  const limits = fig.kids.find((k) => k?.attrs?.class === "rm-limits");
  assert.ok(limits, "読み方の一文がありません");
  assert.match(limits.text, /道は描いていません/);
  assert.match(limits.text, /線は訪れる順/);
  assert.match(limits.text, /直線の距離/);
}));

test("いちばん離れた2か所の距離を、直線と書いて出す", () => withDom(() => {
  const fig = routeDiagram(KYOTO, { el });
  const limits = fig.kids.find((k) => k?.attrs?.class === "rm-limits");
  // 京都駅→金閣寺は直線で8km前後です。
  assert.match(limits.text, /直線で \d+(\.\d)?km/);
}));

test("名前を出さなかったときは、その数を書く", () => withDom(() => {
  // 重なる札を黙って消すと、「図に無い場所は旅程にも無い」と読まれます。
  // 遠くに1か所あると、残りは枠の中で団子になります。**これは作った
  // 話ではありません**——朝に空港へ出て、あとは街なかを歩く日がこの形
  // です。
  const dense = [{ lat: 35.55, lng: 139.78, label: "羽田空港",
                   kind: "origin" }];
  for (let i = 0; i < 12; i++) {
    dense.push({ lat: 35.71 + i * 0.0006, lng: 139.77, label: `場所${i}`,
                 kind: "spot", order: i + 1, time: "10:00" });
  }
  const fig = routeDiagram(dense, { el });
  const limits = fig.kids.find((k) => k?.attrs?.class === "rm-limits");
  assert.match(limits.text, /か所の名前は出していません/);
  assert.match(limits.text, /旅程の一覧には残っています/);
}));

test("北がどちらかを、図の中に書く", () => withDom(() => {
  // 上が北であることは、見れば分かるものではありません。
  const made = routeSvg(KYOTO);
  const texts = [...made.node.querySelectorAll?.("text") ?? []];
  // querySelectorAll が無い環境（素の jsdom 無し）では、文字列で見ます。
  const xml = made.node.outerHTML ?? "";
  assert.ok(texts.some((t) => t.textContent === "北") || xml.includes("北")
    || made.node.textContent?.includes("北"),
    "北の向きが図に入っていません");
}));

test("外の網に、何も聞きに行かない", () => {
  // この図が要るのは圏外です。1つでも取りに行く作りが混ざっていたら、
  // そこで止まります。
  assert.ok(!/fetch\(|XMLHttpRequest|tileUrl|leaflet|window\.L/i.test(source),
    "圏外で使う図が、外へ聞きに行こうとしています");
});

test("右がふさがっていたら、左や下に置く（諦める前に）", () => withDom(() => {
  // はじめは「右に出す。近くに札があれば出さない」だけでした。東京駅→
  // 草津温泉の日帰り（点が4つ）で、**4つのうち2つの名前が消えました**。
  // 空きはいくらでもあるのに、右がふさがっていただけです。
  const pts = [
    { lat: 35.681, lng: 139.767, label: "東京駅", kind: "origin" },
    { lat: 36.622, lng: 138.596, label: "草津温泉", kind: "spot", order: 1,
      time: "12:16" },
    { lat: 36.623, lng: 138.597, label: "湯畑", kind: "spot", order: 2,
      time: "13:30" },
    { lat: 35.681, lng: 139.767, label: "東京駅", kind: "end" },
  ];
  const made = routeSvg(pts, { width: 640, height: 420 });
  // 4つのうち、名前が出ないのは多くて1つ（同じ座標の東京駅が2回）まで。
  assert.ok(made.hidden <= 1,
    `4か所のうち ${made.hidden}か所の名前が出ていません`);
}));

test("図の外に、はみ出した名前を置かない", () => withDom(() => {
  // 切れた名前は読めません。枠から出る置き方は使いません。
  const pts = [
    { lat: 35.0, lng: 135.0, label: "とてもとても長い名前の場所",
      kind: "spot", order: 1, time: "10:00" },
    { lat: 35.2, lng: 135.4, label: "もうひとつ長い名前の場所",
      kind: "spot", order: 2, time: "14:00" },
  ];
  const made = routeSvg(pts, { width: 320, height: 240 });
  assert.ok(made, "図が作られていません");
  // 出せたものは、どれも枠の中にあること（x は 0〜320）。
  for (const t of made.node.children.filter((c) => c.tag === "text"
      && c.attrs.get("class") === "rm-name")) {
    const x = Number(t.attrs.get("x"));
    assert.ok(x >= 0 && x <= 320, `札が x=${x} にあります（枠は0〜320）`);
  }
}));

test("日をまたぐ長い移動で、その日の広がりを潰さない", () => withDom(() => {
  // 東京→草津は148kmあります。旅ぜんぶを1枚に描くと、この148kmが図を
  // 占めて、**草津の中の3か所が1つの点に潰れます**。縮尺は20kmになり、
  // 知りたかった「宿から湯畑まで歩けるか」が読めません。
  //
  // 日ごとに分けても、出発地をその日の図に足すと同じことが起きます
  // （1日目の図にも2日目の図にも、148kmの直線が1本走るだけ）。
  // **その日の広がりより遠い端は、図に入れません。**
  const pts = [
    { lat: 35.6812, lng: 139.7671, label: "東京駅", kind: "origin" },
    { lat: 36.6222, lng: 138.5963, label: "草津温泉", kind: "spot",
      order: 1, day: 0, time: "12:16" },
    { lat: 36.6235, lng: 138.5975, label: "湯畑", kind: "spot",
      order: 2, day: 0, time: "14:00" },
    { lat: 36.6431, lng: 138.5283, label: "白根山", kind: "spot",
      order: 3, day: 1, time: "9:40" },
    { lat: 36.6478, lng: 138.5287, label: "湯釜", kind: "spot",
      order: 4, day: 1, time: "10:30" },
    { lat: 35.6812, lng: 139.7671, label: "東京駅", kind: "end" },
  ];
  const groups = groupByDay(pts);
  assert.ok(groups.length >= 2, "日ごとに分かれていません");
  for (const g of groups) {
    assert.ok(!g.points.some((p) => p.label === "東京駅"),
      `${g.label} の図に、148km 離れた東京駅が入っています`);
  }
  // その日の図の広がりが、歩ける大きさに収まっていること。
  for (const g of groups) {
    const span = Math.max(...g.points.flatMap(
      (a2) => g.points.map((b2) => Math.hypot(
        (a2.lat - b2.lat) * 111, (a2.lng - b2.lng) * 91))));
    assert.ok(span < 30, `${g.label} の図が ${span.toFixed(0)}km あります`);
  }
  // 入れなかったことを、書いてあること。
  const fig = routeDiagram(pts, { el });
  const limits = fig.kids.find((k) => k?.attrs?.class === "rm-limits");
  assert.match(limits.text, /日をまたぐ移動は、この図には入れていません/);
  assert.match(limits.text, /出発地・終点はその日の範囲から遠いため/);
}));

test("出発地がその日の範囲の中なら、図に入れる", () => withDom(() => {
  // 遠いものだけを外します。同じ街から始まる日は、駅が図にある方が
  // 「駅からどれくらい歩くか」が読めます。
  const pts = [
    { lat: 34.9858, lng: 135.7588, label: "京都駅", kind: "origin" },
    { lat: 34.9949, lng: 135.7850, label: "清水寺", kind: "spot",
      order: 1, day: 0, time: "10:00" },
    { lat: 35.0037, lng: 135.7788, label: "八坂神社", kind: "spot",
      order: 2, day: 0, time: "12:00" },
    { lat: 35.0271, lng: 135.7960, label: "銀閣寺", kind: "spot",
      order: 3, day: 1, time: "10:00" },
    { lat: 35.0394, lng: 135.7292, label: "金閣寺", kind: "spot",
      order: 4, day: 1, time: "14:00" },
  ];
  const groups = groupByDay(pts);
  assert.ok(groups[0].points.some((p) => p.kind === "origin"),
    "近くにある出発地まで外しています");
}));

test("点が1つしかない日は、1枚の図にしない", () => withDom(() => {
  // 点1つの図は何も伝えません。前の日に足して、移動として見せます。
  const pts = [
    { lat: 35.0, lng: 135.0, label: "A", kind: "spot", order: 1, day: 0 },
    { lat: 35.1, lng: 135.1, label: "B", kind: "spot", order: 2, day: 0 },
    { lat: 35.5, lng: 135.5, label: "C", kind: "spot", order: 3, day: 1 },
  ];
  const groups = groupByDay(pts);
  for (const g of groups) {
    assert.ok(g.points.length >= 2,
      `${g.label} の図が ${g.points.length}点しかありません`);
  }
}));

test("携帯の幅でも、図の中の字が縮まない", () => withDom(() => {
  // 640 で描いて CSS で width:100% にしていたら、箱の幅 366px の携帯で
  // **0.57倍に縮み、11px の札が6px になりました。** viewBox の中の字は
  // 枠の縮小と一緒に縮みます。はじめから箱の幅で描くしかありません。
  const pts = [
    { lat: 34.9949, lng: 135.7850, label: "清水寺", kind: "spot", order: 1,
      time: "10:00" },
    { lat: 35.0037, lng: 135.7788, label: "八坂神社", kind: "spot", order: 2,
      time: "12:00" },
  ];
  const narrow = routeSvg(pts, { width: 350 });
  const box = narrow.node.attrs.get("viewBox").split(" ");
  assert.equal(box[2], "350",
    `箱が 350px なのに viewBox が ${box[2]} で描かれています`);
  // 枠の高さも、その幅に見合っていること（縦に間延びしない）。
  assert.ok(Number(box[3]) <= 460, `高さが ${box[3]} あります`);
}));

test("幅をもらえなかったときも、640 で決め打ちしない", () => {
  const source2 = fs.readFileSync(new URL("../js/routemap.js",
    import.meta.url), "utf8");
  // 呼ぶ側が測って渡すのが本筋ですが、渡されないときも画面の幅を見ます。
  assert.match(source2, /function defaultWidth/);
  assert.match(source2, /documentElement\?\.clientWidth/);
  // 呼ぶ側（js/map.js）が、箱の幅を測って渡していること。
  const map = fs.readFileSync(new URL("../js/map.js", import.meta.url),
    "utf8");
  assert.match(map, /function boxWidth/);
  assert.match(map, /width: boxWidth\(this\.el\)/);
});

test("見出しの段を飛ばさない", () => withDom(() => {
  // 地図は旅程の h2 より**前**にあります。h3 で決め打ちにしていたら、
  // 画面の見出しが h1 → h3 と飛び、axe（heading-order）が拾いました。
  // 読み上げで見出しを辿る人は、そこで1段抜けたように聞こえます。
  const fig = routeDiagram([
    { lat: 35, lng: 139, label: "A", kind: "spot", order: 1 },
    { lat: 35.1, lng: 139.1, label: "B", kind: "spot", order: 2 },
  ], { el, heading: "順路" });
  const head = fig.kids.find((k) => k?.attrs?.class === "rm-head");
  assert.equal(head.tag, "h2", `見出しが ${head.tag} で出ています`);
  // 置く側が深さを選べること。
  const deep = routeDiagram([
    { lat: 35, lng: 139, label: "A", kind: "spot", order: 1 },
    { lat: 35.1, lng: 139.1, label: "B", kind: "spot", order: 2 },
  ], { el, heading: "順路", headingLevel: "h3" });
  assert.equal(deep.kids.find((k) => k?.attrs?.class === "rm-head").tag, "h3");
}));
