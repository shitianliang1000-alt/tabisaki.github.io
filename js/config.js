// ===========================================================================
//  設定
//
//  変更するのはこのファイルだけです。
// ===========================================================================

/**
 * 自分のバックエンドの入口（https のみ）。
 * Cloudflare Worker を経由して Gemini / Routes API / Yahoo!路線情報へ接続します。
 */
export const PROXY_URL = "https://tabisaki-github-io.shitianliang1000.workers.dev";

// --- 1. Google AI Studio（Gemini）のキー -----------------------------------
// PROXY_URL を使う場合は、ここは空のままにしてください。
export const GEMINI_API_KEY = "";

// --- 2. Google Maps Platform（Routes API）のキー ---------------------------
// PROXY_URL を使う場合は、キーはCloudflare Worker側に置きます。
export const MAPS_API_KEY = "";

/** 経路APIを使うか。 */
export const USE_ROUTES_API = true;

// --- 3. どのモデルを、どこで動かすか ---------------------------------------
/**
 * どこでAIを動かすか。
 *
 *   "cloudflare" … 中継（Cloudflare Worker）の中で動かす。**キー不要**
 *   "gemini"     … Google AI Studio のキーで呼ぶ
 *   "local"      … 手元のOllamaなど（LOCAL_BASE_URL）
 *
 * 既定は "cloudflare" です。鍵を置き忘れて「API key not valid」になる
 * 道がそもそもありません。料金は Cloudflare のアカウント側（無料枠あり）。
 */
export const MODEL_PROVIDER = "cloudflare";

// Workers AI で動かすモデル。E2B は Workers AI には無いので、Gemma 4 の
// うち配信されているものを使います（26B-A4B は実際に動く4Bぶんの重みで、
// 端末向けのE2Bより素直に賢いはずです）。
export const CF_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const CF_FALLBACK_MODELS = ["@cf/google/gemma-3-12b-it"];

// 手元で動かす場合（Ollama など）。E2B は端末で動かす前提の大きさです。
export const LOCAL_MODEL = "gemma4:e2b";
export const LOCAL_BASE_URL = "http://localhost:11434";

// Gemini API 経由で呼ぶモデル。
//
// **E2B は Gemini API では配信されていません。**Gemma 4 は E2B / E4B /
// 26B-A4B / 31B の4つですが、API で呼べるのは 26B-A4B と 31B です
// （E2B は端末側＝LiteRT・Ollama 向け）。ここには E2B を先頭に置き、
// 呼べなければ下へ落ちるようにしています。ai.js は 400/404 を受けると
// 次の候補へ進むので、配信が始まればそのまま E2B が使われます。
// 手元の E2B を使いたい場合は MODEL_PROVIDER を "local" にしてください。
export const MODEL = "gemma-4-e2b-it";
export const FALLBACK_MODELS = [
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
];
export const EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIM = 768;

// --- 4. 知識ベースの公開URL -------------------------------------------------
export const KB_INDEX_URL = "kb/index.json";

// --- 5. 地図（OpenStreetMap） ----------------------------------------------
export const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// --- 6. 挙動の調整 ----------------------------------------------------------
export const TUNING = {
  safetyBufferMin: 15,
  maxWaitMin: 75,
  mealMin: 60,
  mealYen: 1500,
  lodgingYen: 12000,
  transitThresholdKm: 2.5,
  // ここまでは歩く、という距離。1.4kmにしていましたが、旅先で荷物を
  // 持って歩くと、1kmを超えたあたりからつらくなります。
  walkableKm: 1.0,
  // 徒歩の実測（Googleの経路API）に使う回数。ここは課金対象なので絞ります。
  maxTransitRequests: 8,
  // Yahoo!路線情報に聞く回数。こちらは課金されず、中継側で1時間控える
  // ので、**実際の時刻を全区間ぶん取りにいきます**。目安で埋めるくらいなら
  // 時間をかけて本物を取ったほうがよい、という判断です。
  maxYahooRequests: 40,
  // 案を練り直す回数。作って、検証して、問題を伝えてまた作らせます。
  // 1回で止めていたころは、「時間が合わない場所が3件」のまま出ることが
  // ありました。時間はかかっても、通る案に近づけます。
  maxPlanRounds: 4,
  dayEndHour: 18.5,
  dayStartHour: 9.0,
};
