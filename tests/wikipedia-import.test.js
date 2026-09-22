// ウィキペディアの一覧から足すときの、線引き。
//
// 収録はすでに Wikidata から3万件ほど入っています。足りないのは、
// **分類が付いていない場所**です（古墳、峠、渓谷、用水路）。日本語版の
// 一覧記事は、その分野に詳しい人が「これは載せる」と判断した結果なので、
// 分類が無くても拾えます。
//
// ただし一覧記事は、場所でないものへも大量にリンクしています
// （都道府県、カテゴリ、ほかの一覧）。ここで確かめたいのは、
// **場所でないものを足していないか**です。
//
// 取り込みそのものは Python（tools/import_wikipedia_lists.py）ですが、
// 線引きの決まりはここに書いて、目で見えるようにしておきます。

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");

const fetcher = read("tools/fetch_wikipedia_lists.py");
const importer = read("tools/import_wikipedia_lists.py");

test("出典は Wikipedia とだけ書く", () => {
  // 記事名は wikipedia 欄に入るので、そこから記事へたどれます。
  assert.match(importer, /"name": "Wikipedia"/);
  assert.match(importer, /SRC = "wikipedia"/);
  // 足したものだけを、あとからまとめて外せること。
  assert.match(importer, /"src": SRC/);
});

test("一覧の分類が、収録にすでにある名前に寄せてある", () => {
  // 新しい分類名を作ると、滞在時間も同行者の判定も既定値になります
  // （js/access.js・js/arrive.js・js/replan.js・js/art.js はどれも
  //  分類で動きます）。収録に無い名前を増やさないこと。
  const block = fetcher.match(/^LISTS = \{([\s\S]*?)^\}/m)[1];
  const cats = new Set([...block.matchAll(/:\s*"([^"]+)",/g)].map((m) => m[1]));
  assert.ok(cats.size >= 10, `分類が ${cats.size} 種類しかありません`);
  // 収録の分類（art.js の表）に載っているものだけを使います。
  const art = read("js/art.js");
  const known = new Set([...art.matchAll(/([^\s{,:]+):\s*"[a-z-]+"/g)]
    .map((m) => m[1]));
  const extra = [...cats].filter((c) => !known.has(c));
  assert.deepEqual(extra, [],
    `収録に無い分類を作っています: ${extra.join(" / ")}`);
});

test("ユーザーが挙げた一覧を、ぜんぶ見に行く", () => {
  for (const want of [
    "日本の温泉地一覧", "日本の古墳一覧", "日本の湖沼一覧", "日本の山一覧",
    "日本の川一覧", "日本の寺院一覧", "日本の島の一覧", "日本の史跡一覧",
    "日本の国宝一覧", "日本の人造湖一覧", "日本の観光地一覧",
    "日本の特別史跡一覧", "日本の特別名勝一覧", "日本の用水路一覧",
    "神社一覧", "日本のスキー場一覧", "日本の橋一覧", "重要文化財一覧",
    "日本の植物園一覧", "日本の峡谷・渓谷一覧", "日本国指定名勝の一覧",
    "日本の峠一覧", "日本の鉱山の一覧", "日本の海水浴場一覧",
  ]) {
    assert.ok(fetcher.includes(`"${want}"`), `${want} を見ていません`);
  }
  // 都道府県ごとの「〇〇の観光地」も。全国の一覧は載る基準が厳しく、
  // その土地の人が行く場所まで拾えません。
  assert.match(fetcher, /f"\{_p\}の観光地"/);
  const prefs = fetcher.match(/PREFECTURES = \[([\s\S]*?)\]/)[1]
    .match(/"[^"]+"/g);
  assert.equal(prefs.length, 47, `都道府県が ${prefs.length} 件です`);
});

test("場所でないものを足さない", () => {
  // 一覧記事は、都道府県・カテゴリ・ほかの一覧へも大量にリンクします。
  for (const bad of ["一覧", "国立公園", "国定公園", "空港",
                     "インターチェンジ", "市", "区", "町", "村", "郡"]) {
    assert.ok(importer.includes(`"${bad}"`),
      `「${bad}」で終わる名前を落としていません`);
  }
  assert.match(importer, /BAD_PART = \([^)]*"の一覧"/);
  // 日本の外（座標が海外）のものも落とすこと。
  assert.match(importer, /20\.0 <= lat <= 46\.5/);
});

test("すでに収録にあるものを、二重に足さない", () => {
  // 同じ場所が1つの旅程に2回出ます。
  assert.match(importer, /from dedupe_spots import same_place/);
  assert.match(importer, /same_place\(probe, s\)/);
  // 座標が離れていても、同じエリアに同じ名前があるものも足しません。
  assert.match(importer, /\(region\["id"\], r\["title"\]\) in named/);
});

test("置き場所の無いものは、無理に置かない", () => {
  // 近いエリアが1つも無い土地に置くと、移動時間がまるごと狂います。
  assert.match(importer, /MAX_REGION_KM = 30\.0/);
  assert.match(importer, /> MAX_REGION_KM/);
});

test("無い数字を作らない（定番か穴場かの決めかた）", () => {
  // Wikidata から入れたものは他言語版の記事数で決めています。
  // 一覧記事にはその数字がありません。**代わりに、手元にある数**
  //（いくつの一覧に載っているか）で決めます。
  assert.match(importer, /lists >= TIER_MAJOR/);
  assert.match(importer, /seen_in\[title\] \+= 1/);
  assert.match(importer, /いくつの一覧に載っているか/);
});

test("説明は、文の途中で切らない", () => {
  // 半端に切れた文は、読んだ人に「続きがある」と思わせるだけです。
  assert.match(importer, /途中で切りません/);
  assert.match(importer, /\[\^。\]\*。/);
});

test("相手の回線を、急かさない", () => {
  // 寄付で動いている公共の百科事典です。
  assert.match(fetcher, /PAUSE_SEC = 8\.0/);
  assert.match(fetcher, /RETRIES = \[/);
  // 名乗ってから聞くこと（誰が叩いているか分かるように）。
  assert.match(fetcher, /UA = \(/);
  assert.match(fetcher, /tabisaki-kb/);
});

test("同じ題を、二度聞かない", () => {
  // 一覧どうしは重なります（「京都府の観光地」と「日本の観光地一覧」に
  // 同じ寺が出ます）。控えを1つ持って、全部の一覧で使い回します。
  assert.match(fetcher, /def load_cache/);
  assert.match(fetcher, /not cache\[t\]\.get\("extract"\)/);
  // 途中で断られても、聞いたぶんは残ること。
  assert.match(fetcher, /save_cache\(cache\)/);
});

test("本文を解析しない（リンクと座標だけを見る）", () => {
  // 表の書き方は記事ごとにばらばらで、解析すると記事が直されるたびに
  // 壊れます。組み上がった HTML をもらっても、見るのはリンクだけです。
  assert.match(fetcher, /本文を解析しません/);
  assert.match(fetcher, /rel="mw:WikiLink"/);
  // 表の中身に手を出していないこと。ウィキテキストの記法が出てきたら、
  // それは表を読もうとしている印です。
  assert.ok(!/\{\{|\|-|\|\}/.test(fetcher),
    "表（ウィキテキスト）を読もうとしています");
});

test("座標は配布ファイルから取る（API で3万件は聞かない）", () => {
  const coords = read("tools/wikipedia_coords.py");
  // 座標を API で聞くと50件ずつ＝3万件で600回になり、途中から 429 で
  // 断られました（待ち時間が 600秒まで伸びました）。ウィキメディア自身の
  // 案内が「まとめて欲しいなら配布ファイルを」なので、そうしました。
  assert.match(coords, /dumps\.wikimedia\.org/);
  assert.match(coords, /geo_tags/);
  assert.match(fetcher, /def from_dump/);
  assert.ok(!/"prop": "coordinates/.test(fetcher),
    "座標をまた API で聞いています（3万件は通りません）");
});

test("配布ファイルを半分だけ読んで、そのまま保存しない", () => {
  const coords = read("tools/wikipedia_coords.py");
  // 落とし損ねたファイルや、形の変わったファイルを読むと、**一部の記事
  // だけ座標を持つ表**ができます。どの記事が欠けたのかは、できた表から
  // は分かりません。少なすぎたら、書かずに止めます。
  assert.match(coords, /if len\(table\) < 10000:/);
  assert.match(coords, /raise SystemExit/);
  // 途中で切れた落としものを、残さないこと。
  assert.match(coords, /\.part/);
  assert.match(coords, /os\.replace\(tmp, path\)/);
});

test("日本の外の記事を、日本の行き先にしない", () => {
  const coords = read("tools/wikipedia_coords.py");
  // 日本語版にはパリのノートルダムの記事もあり、座標も付いています。
  assert.match(coords, /BBOX/);
  assert.match(coords, /lo_lat <= lat <= hi_lat/);
});

test("説明を聞くのは、収録に入ると決まったものだけ", () => {
  const importer = read("tools/import_wikipedia_lists.py");
  // 説明は配布ファイルから取れないので API で聞きます。ただし3万件を
  // 聞けば結局600回です。足すと決まったものだけにします。
  assert.match(importer, /want-extracts\.json/);
  assert.match(fetcher, /def fetch_extracts/);
  assert.match(fetcher, /def wanted_titles/);
  // 聞けなかったものは、説明なしで出ること（作らないこと）。
  assert.match(fetcher, /説明が無いスポットは、説明なしで/);
});

test("一覧の中身は REST からもらう（action API の prop=links は通らない）", () => {
  // 一覧記事のリンクは1本で1800件を超えます。ウィキメディアはこの
  // 「高い」問い合わせに厳しい上限をかけていて、共用の回線からだと
  // 1回目から 429 が返りました。8秒あけても15秒あけても同じでした。
  // REST（api.wikimedia.org）は記事1本ぶんが1回で返り、通ります。
  assert.match(fetcher, /api\.wikimedia\.org\/core\/v1\/wikipedia\/ja/);
  assert.ok(!/"prop": "links"/.test(fetcher),
    "prop=links に戻っています（429 で止まります）");
  // なぜそうしたかが、書いてあること。次に読む人が戻さないように。
  assert.match(fetcher, /429/);
});

test("名前空間つきのリンクは、場所として数えない", () => {
  // 組み上がった HTML には Category: や ファイル: へのリンクも混じり
  // ます。題に座標が無いので落ちはしますが、そのぶん余計に問い合わせる
  // ことになります。先に落とします。
  assert.match(fetcher, /NAMESPACES/);
  for (const ns of ["Category", "ファイル", "Template", "Wikipedia"]) {
    assert.ok(fetcher.includes(`"${ns}"`), `名前空間 ${ns} が抜けています`);
  }
});

test("取れなかった一覧と、リンクが0件の一覧を、取り違えない", () => {
  // 取れなかったときに空文字を返すと、「リンクが1件も無い一覧」と
  // 同じ形になります。そうなると空のファイルが保存され、**次に走らせた
  // ときも「もう取った」と見なして飛ばします**。取れないなら None です。
  assert.match(fetcher, /空文字を返すと/);
  assert.match(fetcher, /return None/);
  // 空の結果はファイルに書かないこと。
  assert.match(fetcher, /if not titles:\n {8}return/);
});
