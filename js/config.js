// ===========================================================================
//  設定
//
//  変更するのはこのファイルだけです。
//
//  公開するなら、まず PROXY_URL を読んでください
//  --------------------------------------------
//  下の2つのキーをここに書くと、**ページを開いた人から見えます**。
//  ブラウザから直接 Google を呼ぶ以上、これは避けられません。
//  個人利用や localhost ならそのままで構いませんが、公開サイトにすると
//  第三者に使われて課金だけが増えます。
//
//  PROXY_URL に自分のバックエンドを書くと、キーをブラウザに置かずに
//  済みます。参照実装は server/ にあります（Cloudflare Worker と Node）。
// ===========================================================================

/**
 * 自分のバックエンドの入口（https のみ）。
 *
 * 空なら、これまでどおりブラウザから直接 Google を呼びます。
 * 設定すると、下の GEMINI_API_KEY / MAPS_API_KEY は**使われません**
 * （キーはサーバー側に置きます）。
 *
 *   例: "https://tabisaki-api.example.workers.dev"
 *
 * サーバーが実装すべき入口は3つだけです。
 *   POST {PROXY_URL}/gemini/generate
 *   POST {PROXY_URL}/gemini/embed
 *   POST {PROXY_URL}/routes
 * 詳しくは server/README.md を参照してください。
 */
export const PROXY_URL = "";

// --- 1. Google AI Studio（Gemini）のキー -----------------------------------
// PROXY_URL を使う場合は、ここは空のままにしてください。
// https://aistudio.google.com/apikey で発行して、ここに貼り付けてください。
export const GEMINI_API_KEY = "";

// --- 2. Google Maps Platform（Routes API）のキー ---------------------------
// Cloud コンソールで Routes API を有効化したキー。
// 空のままでも動きます（移動時間が直線距離からの推定になり、画面に「推定」と出ます）。
export const MAPS_API_KEY = "";

/**
 * 経路APIを使うか。false にすると一切呼びません（距離からの推定になります）。
 * 設定を直すまでのあいだ、課金だけが増えるのを止めるためのスイッチです。
 */
export const USE_ROUTES_API = true;

// --- 3. どのモデルを、どこで動かすか ---------------------------------------

/**
 * 使うモデルの出どころ。
 *
 *   "gemini" … Google の API（既定）
 *   "local"  … 自分で立てたサーバー（Ollama / vLLM / llama.cpp など）
 *
 * "local" にすると、**呼び出しに課金は発生しません**。自分の機械で
 * 動かすからです。Gemma のような公開重みのモデルはこちらで使います。
 *
 * ただし、できないことがあります（LOCAL_MODEL の説明を読んでください）。
 * PROXY_URL と併用してください。ブラウザから直接ローカルサーバーを
 * 叩く構成は、公開すると誰でも叩ける入口になります。
 */
export const MODEL_PROVIDER = "gemini";

/**
 * "local" のときに使うモデル名。
 *
 * OpenAI 互換の `/v1/chat/completions` を話すものなら何でも構いません。
 *   Ollama  : `ollama run gemma3n:e2b` → モデル名は "gemma3n:e2b"
 *   vLLM    : 起動時に渡した --served-model-name
 *   LM Studio / llama.cpp server も同じ形です。
 *
 * 小さいモデルで気をつけること
 * ----------------------------
 * ・**JSON スキーマの強制ができません。** Gemini の responseSchema に
 *   あたるものが無いので、「この形で返して」と頼み、読めなければ
 *   温度を下げてもう一度だけ聞く、という作りに落ちます（ai.js）。
 * ・**Google 検索が使えません。** 収録に無い土地を調べる discover.js は
 *   動きません。収録済みの範囲だけで旅程を組みます。
 * ・**指示の守りかたが弱くなります。** ただし、このアプリはモデルが
 *   返した ID を候補集合と必ず照合します。存在しない場所を作られても、
 *   そこで落ちます。旅程が壊れる方向には効きません。
 * ・埋め込み（意味検索）は別のモデルが要ります。無ければ語句検索に
 *   落ちます（EMBED_MODEL を空にしてください）。
 */
export const LOCAL_MODEL = "gemma3n:e2b";

/**
 * "local" で、プロキシを使わずに直接叩くときの入口。
 * OpenAI 互換のサーバーのルートを書きます（末尾に /v1 は不要）。
 *
 *   Ollama の既定 : "http://localhost:11434"
 *
 * 公開サイトでは **使わないでください**。PROXY_URL 経由にします。
 *
 * ブラウザから直に叩くときに、2つ引っかかります
 * ---------------------------------------------
 * 1. **CORS。** Ollama は既定で他のページからの呼び出しを断ります。
 *    `OLLAMA_ORIGINS=http://localhost:8000 ollama serve` のように、
 *    このページの出どころを許してから起動してください。
 *    （これが無いと、プリフライトで止まり、画面には何も出ません）
 * 2. **CSP。** index.html の connect-src に、この行き先を足してください。
 *    足さないと、ブラウザが接続そのものを拒みます。
 *
 * どちらも、PROXY_URL 経由にすれば要りません。プロキシは同じ出どころ
 * （または connect-src に書いた1か所）だけを相手にするからです。
 */
export const LOCAL_BASE_URL = "http://localhost:11434";

export const MODEL = "gemini-3.7-flash";

// MODEL が使えなかったときに、上から順に試す控え。
// 契約やリージョンによっては特定のモデルにアクセスできないことがあるため、
// 旅程作成がそこで止まらないように用意しています。
// 実際に使われたモデル名は、画面の「検証メモ」とブラウザのコンソールに出ます。
export const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

// 検索用の埋め込みモデル。生成モデルとは別系統で、ここは固定です。
export const EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIM = 768;

// --- 4. 知識ベースの公開URL -------------------------------------------------
// kb/build_kb.py で生成した public/ を公開した先の index.json。
// 空の場合はアプリ同梱のサンプルデータで動作します（動作確認用）。
export const KB_INDEX_URL = "kb/index.json";

// --- 5. 地図（OpenStreetMap） ----------------------------------------------
// OSM のタイルサーバーは公共資源です。個人利用の範囲を超える場合は
// タイル提供元を変更してください（利用規約: https://operations.osmfoundation.org/policies/tiles/）
export const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// --- 6. 挙動の調整 ----------------------------------------------------------
export const TUNING = {
  // 帰着期限の手前に必ず残す余裕（分）
  safetyBufferMin: 15,
  // スポットの開館を待ってもよい最長時間（分）
  maxWaitMin: 75,
  // 食事に充てる時間（分）と概算費用（円）
  mealMin: 60,
  mealYen: 1500,
  // 宿泊の概算費用（円）
  lodgingYen: 12000,
  // スポット間がこの距離（km）を超えたら徒歩ではなく公共交通とみなす
  transitThresholdKm: 2.5,
  // 徒歩でつなぐ上限（km）。これ以下の区間はまとめて1回で取ります
  walkableKm: 1.4,
  // 1回の旅程作成で、公共交通の経路を個別に取りにいく上限。
  // 公共交通は経由地をまとめられないので、区間ごとに1リクエスト要ります。
  // 長い区間から順に使い、使い切ったぶんは距離からの推定にします。
  maxTransitRequests: 8,
  // 1日の観光を終える目安の時刻
  dayEndHour: 18.5,
  // 2日目以降に観光を始める時刻
  dayStartHour: 9.0,
};
