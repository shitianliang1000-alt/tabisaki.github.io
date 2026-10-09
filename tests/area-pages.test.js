// エリア別のページ（tools/build_area_pages.mjs）。
//
// 公開のたびに作るページなので、作り直し忘れは起きません。かわりに、
// 作るものが壊れていないことをここで見ます。
//   ・名前に < や " が入っていても、ページが壊れない（収録は外のデータです）
//   ・アプリへのリンクが `?q=` で文を運ぶ
//   ・おかしなモデルコースは出さない（直す人のいないページです）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appLink, buildAll, courseFits, courseItems, curatedRegions, esc,
  examplePrompts, nextSaturday, pickPrefSpots, shardSlug, sitemapXml,
} from "../tools/build_area_pages.mjs";

const BASE = "https://example.test/app/";

const REGION = {
  id: "hakone", name: "箱根", prefecture: "神奈川県", station: "箱根湯本駅",
  stationLat: 35.23, stationLng: 139.1, lat: 35.23, lng: 139.1,
  genres: ["onsen", "art", "nature"],
  tagline: "湯けむりと芦ノ湖", description: "都心から特急一本で行ける温泉地。",
};

const spot = (id, extra = {}) => ({
  id, name: `場所${id}`, regionId: "hakone", category: "美術館",
  fame_tier: "hidden", fame_score: 10, lat: 35.2, lng: 139.1, ...extra,
});

function itinOf(ids, regionId = "hakone", placeRegion = () => "hakone") {
  const at = (h, m = 0) => new Date(2026, 9, 17, h, m);
  const items = [];
  let h = 9;
  for (const id of ids) {
    items.push({ kind: "transit", title: "移動", start: at(h), end: at(h, 20) });
    items.push({ kind: "spot", title: `場所${id}`, spotId: id,
                 place: { id, regionId: placeRegion(id), description: `説明${id}` },
                 start: at(h, 20), end: at(h + 1) });
    h++;
  }
  return { regionId, days: [{ items }] };
}

test("記号はすべて逃がす", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(esc(null), "");
});

test("県の入れ物の名前から、URLの名前を取る", () => {
  assert.equal(shardSlug("spots-jp13-tokyo.json"), "tokyo");
  assert.equal(shardSlug("regions.json"), null);
});

test("例の日付は、次の土曜", () => {
  // 2026-10-09 は金曜。
  assert.equal(nextSaturday(new Date(2026, 9, 9)).getDate(), 10);
  // 土曜なら翌週の土曜（その日はもう始まっています）。
  assert.equal(nextSaturday(new Date(2026, 9, 10)).getDate(), 17);
  assert.equal(nextSaturday(new Date(2026, 9, 10)).getDay(), 6);
});

test("アプリへのリンクは、文を ?q= で運ぶ", () => {
  assert.equal(appLink("../../", "箱根で温泉 & 美術館"),
    "../../index.html?q=%E7%AE%B1%E6%A0%B9%E3%81%A7%E6%B8%A9%E6%B3%89%20%26%20%E7%BE%8E%E8%A1%93%E9%A4%A8");
});

test("書きかたの例は、そのエリアの分類から作る", () => {
  const got = examplePrompts(REGION);
  assert.equal(got[0], "箱根を1日でめぐる");
  assert.ok(got.includes("箱根で温泉でゆっくり"));
  assert.ok(got.length <= 4);
});

test("説明の無い穴場は並べない", () => {
  const { major, hidden } = pickPrefSpots([
    spot("a", { fame_tier: "major", fame_score: 90 }),
    spot("b", { description: "静かな寺" }),
    spot("c"),
  ]);
  assert.deepEqual(major.map((s) => s.id), ["a"]);
  assert.deepEqual(hidden.map((s) => s.id), ["b"]);
});

test("紹介できるのは、説明と駅を持つエリアだけ", () => {
  const got = curatedRegions([REGION, { id: "n0054", name: "村", prefecture: "新潟県" }]);
  assert.deepEqual(got.map((r) => r.id), ["hakone"]);
});

test("モデルコース: そのエリアの旅程で、必ず入れた場所が残っていれば出す", () => {
  assert.equal(courseFits(itinOf(["a", "b", "c"]), REGION, ["a", "b", "c"]), true);
  assert.equal(courseFits(itinOf(["a", "b", "x"]), REGION, ["a", "b", "c"]), true);
});

test("モデルコース: 必ず入れた場所が2か所以上抜けたら出さない", () => {
  assert.equal(courseFits(itinOf(["a", "x", "y"]), REGION, ["a", "b", "c"]), false);
});

test("モデルコース: よそのエリアへ行った旅程は出さない", () => {
  assert.equal(courseFits(itinOf(["a", "b"], "n0235"), REGION, ["a", "b"]), false);
  const leak = itinOf(["a", "b", "z"], "hakone", (id) => (id === "z" ? "n0009" : "hakone"));
  assert.equal(courseFits(leak, REGION, ["a", "b"]), false);
  assert.equal(courseFits(null, REGION, []), false);
});

test("モデルコースの行は、時刻・名前・分で並ぶ", () => {
  const got = courseItems(itinOf(["a"]));
  assert.deepEqual(got.map((x) => [x.kind, x.time, x.minutes]),
    [["move", "9:00", 20], ["spot", "9:20", 40]]);
  assert.equal(got[1].text, "説明a");
  assert.equal(courseItems({ days: [] }), null);
});

test("全ページ: 一覧・県・エリアができ、名前は逃がしてある", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [
      spot("a", { name: `<script>alert(1)</script>`, fame_tier: "major", fame_score: 80 }),
      spot("b", { description: "静かな寺", fame_score: 30 }),
    ]]]),
  };
  const planCourse = async () => itinOf(["a"]);
  const { pages, sitemap } = await buildAll(kbDoc,
    { base: BASE, now: new Date(2026, 9, 9), planCourse });
  assert.deepEqual(pages.map((p) => p.path),
    ["areas/index.html", "areas/kanagawa/index.html", "areas/kanagawa/hakone.html"]);
  for (const p of pages) {
    assert.ok(!p.html.includes("<script>alert"), `${p.path} に生の名前が入っています`);
    assert.match(p.html, /<link rel="canonical" href="https:\/\/example\.test\/app\/areas\//);
    // 画面の中で動くものは置きません（読み物のページです）。
    assert.match(p.html, /script-src 'none'/);
  }
  const region = pages[2].html;
  assert.match(region, /1日のモデルコース/);
  assert.match(region, /10月10日（土）/);
  assert.match(region, /index\.html\?q=/);
  // JSON-LD の中でも、< は逃がしてあること。
  assert.ok(!/<\/script>alert/.test(region));
  assert.match(sitemap, /<loc>https:\/\/example\.test\/app\/<\/loc>/);
  assert.match(sitemap, /areas\/kanagawa\/hakone\.html/);
  assert.match(sitemap, /sitemaps\.org/);
});

test("モデルコースが組めなかったエリアも、観光地の一覧のページは出る", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a")]]]),
  };
  const { pages } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null });
  const region = pages.find((p) => p.path.endsWith("hakone.html")).html;
  assert.ok(!region.includes('class="course"'));
  assert.match(region, /箱根の観光地/);
});

test("sitemap は日付つき", () => {
  const xml = sitemapXml(BASE, [`${BASE}areas/index.html`], new Date("2026-10-09T00:00:00Z"));
  assert.match(xml, /<lastmod>2026-10-09<\/lastmod>/);
});
