// どこへ投げるかを、1か所で決める。
//
// いまの作りでは、APIキーがページを開いた人から見えます。ブラウザから
// 直接 Google を呼ぶ以上、避けられません。開発中や個人利用ならそれで
// 構いませんが、公開するなら第三者に使われて課金だけが増えます。
//
// 直しかたは、自分のバックエンドを1枚挟むことです。
//
//     ブラウザ（キーを持たない）
//        ↓
//     自分のサーバー（キーはここだけ）
//        ↓
//     Gemini / Routes API / Yahoo!路線情報
//
// `js/config.js` の PROXY_URL にその入口を書くと、このモジュールが
// 行き先を切り替えます。**キーはヘッダーに載せません**（サーバーが
// 付けるので、ブラウザが持つ必要がありません）。
//
// 参照実装は `server/` にあります（Cloudflare Worker と Node）。

const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const ROUTES_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

/** プロキシ経由かどうか。 */
export function usingProxy(cfg = {}) {
  return Boolean(String(cfg.proxyUrl ?? "").trim());
}

function proxyBase(cfg) {
  const raw = String(cfg.proxyUrl ?? "").trim();
  if (!raw) return "";
  if (!/^https:\/\//i.test(raw)) {
    throw new Error("PROXY_URL は https で指定してください"
      + "（http では通信の中身が読まれます）");
  }
  return raw.replace(/\/+$/, "");
}

/**
 * 投げ先のURL。
 *
 * @param {"gemini:generate"|"gemini:embed"|"routes"|"yahoo:transit"|"local:generate"} what
 * @param {{model?:string}} [args]
 * @param {{proxyUrl?:string, localBaseUrl?:string}} [cfg]
 */
export function endpointFor(what, args = {}, cfg = {}) {
  const base = proxyBase(cfg);
  if (base) {
    return `${base}/${{ "gemini:generate": "gemini/generate",
                        "gemini:embed": "gemini/embed",
                        "local:generate": "local/generate",
                        "routes": "routes",
                        "status": "status",
                        "yahoo:transit": "yahoo/transit" }[what] ?? what}`;
  }
  if (what === "local:generate") {
    const raw = String(cfg.localBaseUrl ?? "").trim().replace(/\/+$/, "");
    if (!raw) throw new Error("LOCAL_BASE_URL が未設定です（js/config.js）");
    return `${raw}/v1/chat/completions`;
  }
  if (what === "gemini:generate") {
    return `${GEMINI_ROOT}/models/`
      + `${encodeURIComponent(args.model ?? "")}:generateContent`;
  }
  if (what === "gemini:embed") {
    return `${GEMINI_ROOT}/models/`
      + `${encodeURIComponent(args.model ?? "")}:embedContent`;
  }
  return ROUTES_URL;
}

/**
 * 中継に鍵が置かれているか。
 *
 * 「キーが無効です」と「中継に鍵が置かれていない」は別のことです。
 * 前者はキーを作り直す話、後者は `wrangler secret put` の話で、直す
 * 場所が違います。上流に投げる前に、どちらなのかを確かめます。
 * 中継を使っていない（キーをブラウザに置く）ときは null を返します。
 */
export async function proxyStatus(cfg = {}, signal) {
  if (!usingProxy(cfg)) return null;
  const res = await fetch(endpointFor("status", {}, cfg), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * キーのヘッダー。
 *
 * プロキシ経由なら **空を返します**。キーを持たないのがこの仕組みの
 * 目的なので、うっかり載せないよう、ここで一括して止めます。
 */
export function keyHeaders(which, cfg = {}) {
  if (usingProxy(cfg)) return {};
  if (which === "gemini") {
    return cfg.geminiKey ? { "x-goog-api-key": cfg.geminiKey } : {};
  }
  return cfg.mapsKey ? { "X-Goog-Api-Key": cfg.mapsKey } : {};
}
