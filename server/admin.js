// 管理画面を、合言葉を知っている人だけに見せます。
//
// 管理画面（admin/）は GitHub Pages には置きません（誰でも開けるため）。
// 代わりに、この Worker が次の場所で配ります。
//
//   https://<worker>/admin   → 合言葉を聞いてから /private/admin/ へ
//
// /private/ の下は、リポジトリの一番上と同じ並びです。
//   /private/admin/…  … Worker に同梱した admin/ のファイル（ADMIN_FILES）
//   /private/js/… /private/css/… /private/kb/…
//                     … 公開中のサイト（GitHub Pages）から取ってきて渡します
// admin/index.html は ../js/ や ../kb/ を相対で読むので、手元で
// `python3 -m http.server` から開いたときと同じ書きかたのまま動きます。
//
// 合言葉は Worker の secret ADMIN_PASSWORD です。**入れていなければ、
// 管理画面はどこにも出ません**（404）。入れ忘れて丸見えになる、という
// 向きには倒れません。
//
//   npx wrangler secret put ADMIN_PASSWORD
//
// ブラウザが出す「ユーザー名」は何でもかまいません。見るのは合言葉だけです。

export const ADMIN_PREFIX = "/private/";
export const SITE_ORIGIN = "https://shitianliang1000-alt.github.io";
export const SITE_ROOT = `${SITE_ORIGIN}/tabisaki.github.io/`;

// 公開サイトから取ってきてよい場所。これ以外は取りに行きません
// （どこでも中継する入口にはしません）。
const MIRRORED = /^(js|css|kb)\/[A-Za-z0-9._\/-]+$/;
const ADMIN_FILE = /^admin\/[A-Za-z0-9._-]*$/;

/** この入口が管理画面のものか。 */
export function isAdminPath(pathname) {
  return pathname === "/admin" || pathname === "/admin/"
    || pathname === ADMIN_PREFIX.slice(0, -1) || pathname.startsWith(ADMIN_PREFIX);
}

/**
 * 管理画面への GET/HEAD を受けます。
 * fail(ip) は、合言葉を間違えたときに呼ばれます（回数制限に数えるため）。
 */
export async function serveAdmin(request, env, { onBadPassword } = {}) {
  const password = String(env?.ADMIN_PASSWORD ?? "");
  // 合言葉が無い＝管理画面を出さない。在ることも言いません。
  if (!password) return plain("Not found", 404);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain("Method not allowed", 405, { Allow: "GET, HEAD" });
  }

  const supplied = basicPassword(request.headers.get("Authorization"));
  if (supplied === null || !(await sameSecret(supplied, password))) {
    if (supplied !== null && onBadPassword) {
      const gate = await onBadPassword();
      if (gate && !gate.ok) return plain("Too many attempts", 429,
        { "Retry-After": String(gate.retryAfter ?? 60) });
    }
    return plain("合言葉が必要です", 401, {
      "WWW-Authenticate": 'Basic realm="tabisaki-admin", charset="UTF-8"',
    });
  }

  const url = new URL(request.url);
  // 入口。/private/ で合言葉を聞くので、ブラウザは /private/ の下全部に
  // 同じ合言葉を付けて送ります（/private/js/… でまた聞かれません）。
  if (url.pathname === "/admin" || url.pathname === "/admin/"
      || url.pathname === "/private" || url.pathname === ADMIN_PREFIX) {
    return guarded(Response.redirect(new URL(`${ADMIN_PREFIX}admin/`, url).toString(), 302));
  }

  const rest = decodeURIComponent(url.pathname.slice(ADMIN_PREFIX.length));
  if (rest.includes("..")) return plain("Not found", 404);

  if (rest === "admin") {
    return guarded(Response.redirect(new URL(`${ADMIN_PREFIX}admin/`, url).toString(), 302));
  }
  if (ADMIN_FILE.test(rest)) {
    if (!env.ADMIN_FILES) return plain("管理画面のファイルが Worker に入っていません", 503);
    const name = rest.slice("admin/".length) || "index.html";
    const res = await env.ADMIN_FILES.fetch(new Request(`https://admin.files/${name}`,
      { method: request.method }));
    return guarded(res);
  }
  if (MIRRORED.test(rest)) {
    const res = await fetch(`${SITE_ROOT}${rest}${url.search}`, {
      method: request.method,
      headers: { Accept: request.headers.get("Accept") ?? "*/*" },
    });
    return guarded(res);
  }
  return plain("Not found", 404);
}

/** Authorization: Basic … から合言葉だけを取り出します。無ければ null。 */
export function basicPassword(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header ?? ""));
  if (!m) return null;
  let decoded;
  try {
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  return i < 0 ? null : decoded.slice(i + 1);
}

/** 長さや先頭の一致で時間が変わらないよう、ハッシュどうしを全部比べます。 */
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (s) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** 管理画面の返事に付ける見出し。検索に載せず、ほかのページに埋め込ませず、残させません。 */
function guarded(res) {
  const h = new Headers(res.headers);
  h.set("Cache-Control", "no-store");
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function plain(message, status, extra = {}) {
  return guarded(new Response(message, {
    status, headers: { "Content-Type": "text/plain; charset=utf-8", ...extra },
  }));
}
