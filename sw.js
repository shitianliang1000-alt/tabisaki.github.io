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

const VERSION = "tabisaki-v1";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;

/** 先に入れておくもの。ここが欠けるとアプリが開きません。 */
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./css/hig-tokens.css",
  "./css/hig.css",
  "./css/app.css",
];

self.addEventListener("install", (e) => {
  // 1つでも落とせないと install が失敗するので、個別に入れます。
  // js/ は数が多く、名前も変わりうるので、ここでは列挙しません
  // （初回に読んだものが下の fetch で自然に入ります）。
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
