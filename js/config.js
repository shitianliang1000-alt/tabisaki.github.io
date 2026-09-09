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
export const MODEL_PROVIDER = "gemini";
export const LOCAL_MODEL = "gemma3n:e2b";
export const LOCAL_BASE_URL = "http://localhost:11434";
export const MODEL = "gemini-3.7-flash";
export const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
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
