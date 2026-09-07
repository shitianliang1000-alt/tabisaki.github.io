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
  walkableKm: 1.4,
  maxTransitRequests: 8,
  dayEndHour: 18.5,
  dayStartHour: 9.0,
};
