// 旅さき — オフラインで旅程を開けるようにする。
//
// なぜ要るか
// ----------
// このアプリがいちばん役に立つのは、**旅行の当日**です。そして当日は、
// 電波の弱い場所にいます。山の中、地下、海沿い、国外のローミング。
// そこで「今日の旅」が開けないなら、作った意味が半分になります。
//
// 何を保存するか
// --------------
//   1. アプリそのもの（HTML/CSS/JS）… 変わらないので、先に入れておく
//   2. 知識ベース（kb/）          … 大きいので、読んだものだけ後から
//   3. 外部（地図タイル・写真）    … 保存しません（下に理由）
//
// 地図のタイルと写真は入れません。量が読めないうえ、他所のものです。
// 端末の容量を黙って使うことになります。旅程の文字が読めれば、
// 当日にすることは分かります。

// 先に入れるものを増やしたので、版を上げます。上げないと、前の版の
// 殻（js/ の入っていないもの）を持っている端末は入れ直しません。
// 収録の入れ物が変わりました（出典ごと → 県ごと。tools/reshard_kb.py）。
// 版を上げないと、前の版で溜めた 4.8MB が端末に残り続けます。
// v5: 画面の記号を単線SVGに替え、js/ をぜんぶ先に入れるようにしました。
// 先に入れるものが増えたので、また上げます。
const VERSION = "tabisaki-v5";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;

/** 先に入れておくもの。ここが欠けるとアプリが開きません。 */
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./css/hig-tokens.css",
  "./css/hig.css",
  "./css/app.css",
  // **js/ は、ぜんぶ先に入れます。**
  //
  // ここは以前「これが欠けると起動しないものだけ」を手で並べていました。
  // 数えてみると、app.js が import で辿るものは72件あり、そのうち
  // **列挙されていたのは13件**でした。残る45件は「初回に読んだものが
  // 下の fetch で自然に入る」に任されていましたが、それが成り立つのは
  // 一度でも圏内で使ったときだけです。
  //
  //   ホーム画面に追加して、翌朝そのまま山へ行く
  //
  // これをやると、import が1つ解けずに真っ白な画面になります。旅の
  // 当日に、いちばんしてはいけないことです。
  //
  // 手で並べる形は、**黙って腐ります**（新しいモジュールを足した人が
  // ここを直し忘れても、圏内では何も起きないので気づけません）。
  // 全部並べて、tests/sw-shell.test.js が js/ と突き合わせます。
  //
  // 大きさは合計1.4MBです。圏外で開けることのほうが大事です。
  "./js/access.js",
  "./js/ai.js",
  "./js/app.js",
  "./js/areas.js",
  "./js/arrive.js",
  "./js/art.js",
  "./js/backup.js",
  "./js/confidence.js",
  "./js/config.js",
  "./js/cost.js",
  "./js/crowd.js",
  "./js/dedupe.js",
  "./js/discover.js",
  "./js/edit.js",
  "./js/endpoints.js",
  "./js/errors.js",
  "./js/events.js",
  "./js/feasibility.js",
  "./js/fit.js",
  "./js/geo.js",
  "./js/history.js",
  "./js/hours.js",
  "./js/ical.js",
  "./js/icons.js",
  "./js/intent.js",
  "./js/kb.js",
  "./js/keywords.js",
  "./js/lasttrain.js",
  "./js/links.js",
  "./js/lodging.js",
  "./js/luggage.js",
  "./js/map.js",
  "./js/match.js",
  "./js/meals.js",
  "./js/mix.js",
  "./js/modes.js",
  "./js/nextleg.js",
  "./js/normals.js",
  "./js/notify.js",
  "./js/photos.js",
  "./js/pipeline.js",
  "./js/places.js",
  "./js/planner.js",
  "./js/quota.js",
  "./js/relax.js",
  "./js/reliability.js",
  "./js/replan.js",
  "./js/romaji.js",
  "./js/routes.js",
  "./js/sample-data.js",
  "./js/scenic.js",
  "./js/score.js",
  "./js/settings.js",
  "./js/shapes.js",
  "./js/share.js",
  "./js/sketch.js",
  "./js/stays.js",
  "./js/stops-data.js",
  "./js/stops-worker.js",
  "./js/stops.js",
  "./js/story.js",
  "./js/sun.js",
  "./js/tickets.js",
  "./js/today.js",
  "./js/touring.js",
  "./js/trains.js",
  "./js/transfer.js",
  "./js/transit.js",
  "./js/trip.js",
  "./js/typescale.js",
  "./js/ui.js",
  "./js/variants.js",
  "./js/verify.js",
  "./js/weather.js",
  "./js/yahoo-transit.js",
];

self.addEventListener("install", (e) => {
  // 1つでも落とせないと install が失敗するので、個別に入れます
  // （allSettled。1件の取りこぼしで全部が無駄になりません）。
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(SHELL_FILES.map((f) => cache.add(f)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // 古い版のキャッシュを捨てます。放っておくと端末に溜まります。
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => !k.startsWith(VERSION))
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 自分のところ以外は触りません。
  // 地図タイル・写真・API は、そのまま通します（保存もしません）。
  if (url.origin !== self.location.origin) return;

  // 知識ベースは「まずキャッシュ」。3.8MB を毎回取りにいく必要はありません。
  // 更新はバックグラウンドで取り込みます（次に開いたときに新しくなります）。
  if (url.pathname.includes("/kb/")) {
    e.respondWith(staleWhileRevalidate(req, DATA));
    return;
  }

  // 画面は「まずネット、だめならキャッシュ」。
  // 新しい版があるなら、そちらを見せたいためです。圏外のときだけ
  // 保存したものに落ちます。
  e.respondWith(networkFirst(req, SHELL));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // ページの要求で、何も持っていないとき。
    // 真っ白より、理由の書いてある画面のほうがましです。
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit ?? (await fresh) ?? Response.error();
}
