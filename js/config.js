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
 * いまは "gemini"（Google AI Studio）です。Gemma を無料枠で呼ぶと
 * **1日14,400回**まで使えます。Workers AI の無料枠（1日1万ニューロン＝
 * 旅程にすると数十本）より、ずっと余裕があります。
 *
 * キーは中継（Cloudflare Worker）に置きます。ブラウザには置きません。
 *
 *     npx wrangler secret put GEMINI_API_KEY
 */
export const MODEL_PROVIDER = "gemini";

// Workers AI で動かすモデル。E2B は Workers AI には無いので、Gemma 4 の
// うち配信されているものを使います（26B-A4B は実際に動く4Bぶんの重みで、
// 端末向けのE2Bより素直に賢いはずです）。
export const CF_MODEL = "@cf/google/gemma-4-26b-a4b-it";
// 控え。Gemma 3 12B は Cloudflare の一覧で非推奨扱いなので、現役のものに
// します。Gemma 4 が混んでいるときに、控えまで落ちては意味がありません。
export const CF_FALLBACK_MODELS = ["@cf/zai-org/glm-4.7-flash"];

// 手元で動かす場合（Ollama など）。E2B は端末で動かす前提の大きさです。
export const LOCAL_MODEL = "gemma4:e2b";
export const LOCAL_BASE_URL = "http://localhost:11434";

// Gemini API 経由で呼ぶモデル。
//
// **Gemma 4 を使います。**E2B は端末向け（LiteRT・Ollama）なので、
// API で呼べるのは 26B-A4B と 31B です。手元の E2B を使いたい場合は
// MODEL_PROVIDER を "local" にしてください。
//
// 控えには Gemma 3 を置きます。ai.js は 404（そのモデルが無い）を
// 受けると次の候補へ進むので、Gemma 4 がまだ配信されていない時期でも
// 旅程は作れます。どれで通ったかは「接続の確認」に出ます。
export const MODEL = "gemma-4-26b-a4b-it";
export const FALLBACK_MODELS = [
  "gemma-4-31b-it",
  "gemma-3-27b-it",
  "gemma-3-12b-it",
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
  // 開くまで待つのは、ここまで。
  //
  // 75分にしていました。旅程には「浅草寺が開くまで約60分」という行が
  // 立ちます。読む人にとっては、朝いちの1時間が消えるということです。
  // 待つくらいなら、**そのとき開いている別の場所**を先に回ります。
  maxWaitMin: 20,
  // 見学を始めてよい、いちばん早い時刻。
  //
  // 神社や公園は「いつでも入れる」ので、これが無いと午前4時の参拝が
  // 旅程に入ります（実際に「4:11 浅草神社」が出ていました）。入れるか
  // どうかと、行くかどうかは別のことです。暗いうちに着いても、
  // 見るものは見えません。
  earliestVisitHour: 7.0,
  // 時刻表が引けなかった区間に乗せる、乗るまでの待ち時間（分）。
  // 実際の便が取れているときは使いません。
  transitWaitMin: 8,
  mealMin: 60,
  mealYen: 1500,
  lodgingYen: 12000,
  transitThresholdKm: 2.5,
  // ここまでは歩く、という距離。これを超えたら電車かバスを調べます。
  walkableKm: 1.5,
  // 徒歩の実測（Googleの経路API）に使う回数。ここは課金対象なので絞ります。
  maxTransitRequests: 8,
  // Yahoo!路線情報に聞く回数。こちらは課金されず、中継側で1時間控える
  // ので、**実際の時刻を全区間ぶん取りにいきます**。目安で埋めるくらいなら
  // 時間をかけて本物を取ったほうがよい、という判断です。
  maxYahooRequests: 120,
  // 案を練り直す回数。作って、検証して、問題を伝えてまた作らせます。
  // 1回で止めていたころは、「時間が合わない場所が3件」のまま出ることが
  // ありました。時間はかかっても、通る案に近づけます。
  maxPlanRounds: 4,
  dayEndHour: 18.5,
  dayStartHour: 9.0,
};
