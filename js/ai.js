// モデルの担当は「意味の理解」と「選定」だけ。
//
//   ・場所の事実は知識ベースが持つ。モデルは候補から選ぶだけで、
//     返ってきたIDは候補集合と必ず照合する（存在しない場所を作らせない）。
//   ・時刻と移動時間は verify.js が判定する。モデルには判定させない。
//   ・1回目の案が実行不能なら、理由を渡して直させる（2パス）。
//
// モデルIDについて: config.MODEL が現在のAPIに存在しない場合は
// FALLBACK_MODELS を順に試します。どれが実際に動いたかは resolvedModel()
// で取得でき、画面にも表示します。

import {
  FALLBACK_MODELS, EMBED_DIM, EMBED_MODEL, LOCAL_BASE_URL,
  LOCAL_MODEL, MODEL, MODEL_PROVIDER,
} from "./config.js";
import { endpointFor, keyHeaders, usingProxy } from "./endpoints.js";
import { effectiveConfig } from "./settings.js";
import { buildSearchText, extractKeywords } from "./keywords.js";
import { meteredFetch } from "./quota.js";
import { joinAreaNames } from "./stays.js";

/**
 * どこへ投げるか。毎回読み直します。
 * 設定画面で入れたキー（localStorage）が config.js より優先されます。
 */
function net() {
  const c = effectiveConfig();
  return { proxyUrl: c.proxyUrl, geminiKey: c.geminiKey,
           localBaseUrl: LOCAL_BASE_URL };
}

/**
 * 自分で立てたモデルを使うか（Gemma など）。
 *
 * 何が変わるか
 * ------------
 * 呼び出しに課金が発生しません。自分の機械で動かすからです。
 * そのかわり、Gemini でできていた2つが**できません**。
 *
 *   1. JSON の形をモデル側で強制する（responseSchema）
 *      → 「この形で返して」と頼み、読めなければ温度を下げて
 *        もう一度だけ聞きます（callModelJson）。
 *   2. Google 検索で裏を取る（グラウンディング）
 *      → 収録に無い土地を調べる discover.js が動きません。
 *        収録済みの範囲だけで組みます。
 *
 * 小さいモデルは指示の守りかたも弱くなりますが、このアプリは
 * モデルが返した ID を候補集合と必ず照合します。存在しない場所を
 * 作られても、そこで落ちます。旅程が壊れる方向には効きません。
 */
export function usingLocalModel() {
  return MODEL_PROVIDER === "local";
}

/** そのモデルで、Google 検索による裏取りができるか。 */
export function canGround() {
  return !usingLocalModel();
}

let resolved = null;      // 実際に使えたモデルID
let triedOnce = false;

export function resolvedModel() {
  return resolved;
}

/**
 * AIキーが実際に使えるかを、1リクエストだけで確かめます。
 * どのモデルで通ったかも返すので、モデル名の指定違いもここで分かります。
 */
export async function diagnoseGeminiKey(signal) {
  if (usingLocalModel()) {
    try {
      await callLocal("OKとだけ返してください。", { temperature: 0, signal });
      return { ok: true, model: LOCAL_MODEL,
        message: `${LOCAL_MODEL} に接続できました`
          + "（自分で立てたモデルです。検索による裏取りは行いません）。" };
    } catch (e) {
      return { ok: false, message:
        `${LOCAL_MODEL} に接続できませんでした（${e.message}）。`
        + "サーバーが動いているか、LOCAL_BASE_URL が合っているかを"
        + "確認してください。" };
    }
  }
  if (!hasApiKey()) {
    return { ok: false, message: "AIのキーが空です。上の欄に Google AI Studio の"
      + "キーを貼ってください。未設定でも語句検索で動きますが、AIによる"
      + "選定は行われません。" };
  }
  const errors = [];
  for (const model of modelCandidates()) {
    try {
      await callOnce(model, "OKとだけ返してください。", { temperature: 0, signal });
      resolved = model;
      return { ok: true, model,
        message: `${model} に接続できました。` };
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
      if (e.status === 403 || e.status === 401) break;
    }
  }
  const first = errors[0] ?? "";
  const hint = /40[13]/.test(first)
    ? "キーが拒否されました。Google AI Studio でキーを作り直すか、"
      + "そのキーで Generative Language API が有効か確認してください。"
    : /404/.test(first)
      ? "指定のモデルが見つかりません。config.js の MODEL を、"
        + "利用できるモデルIDに変えてください。"
      : "接続できませんでした。";
  return { ok: false, message: `${hint}\n詳細: ${errors.join(" / ")}` };
}

export function hasApiKey() {
  // 自分で立てたモデルは、キーという概念がありません。
  if (usingLocalModel()) return true;
  // プロキシ経由なら、キーはサーバーが持っています。
  // ブラウザ側が空なのは正常なので、それで「使えない」とは判断しません。
  const c = net();
  return usingProxy(c) || Boolean(c.geminiKey);
}

/** モデル候補の順序。指定を最優先し、だめなら控えへ。 */
function modelCandidates() {
  const list = [MODEL, ...FALLBACK_MODELS].filter(Boolean);
  return [...new Set(resolved ? [resolved, ...list] : list)];
}

/**
 * すべての呼び出しに共通する役割の指示。
 *
 * 同じことを毎回プロンプトの先頭に書くより、systemInstruction に置くほうが
 * 守られます。プロンプト本文は指示と資料が混ざるため、後ろに来る資料に
 * 引きずられて、先頭の禁止事項が薄れていました。
 */
const SYSTEM = [
  "あなたは日本の旅行プランナーです。",
  "守ること:",
  "・与えられた候補の中からだけ選ぶ。候補に無い場所・IDを作らない。",
  "・時刻や所要時間を自分で計算しない（別のプログラムが行います）。",
  "・確かでないことを、確かなように書かない。",
  "・出力は指定された JSON だけ。前置き・言い訳・コードフェンスを付けない。",
].join("\n");

/**
 * 送るリクエストの中身。
 *
 * `search: true` を渡すと Google 検索を使わせます。学習した知識だけでは
 * 「今なにが開いていて、何が行われているか」に答えられません。
 * 収録の無い場所を扱うにはこれが要ります。
 *
 * `schema` を渡すと、モデル側で JSON の形を強制します（構造化出力）。
 * 「JSON だけ返して」と頼むより確実で、括弧の欠けや前置きが消えます。
 * ただし検索と構造化出力は同時に使えないため、検索時は外します。
 */
export function buildModelRequest(prompt, {
  temperature = 0.4, search = false, schema = null, topP, thinking,
} = {}) {
  const generationConfig = { temperature };
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  if (schema && !search) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }
  // 選定は「候補を見比べて絞る」作業なので、考える余地があるほど当たります。
  // 対応しないモデルではこの項目は無視されます。
  if (Number.isFinite(thinking)) {
    generationConfig.thinkingConfig = { thinkingBudget: thinking };
  }
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: SYSTEM }] },
    generationConfig,
  };
  if (search) body.tools = [{ google_search: {} }];
  return body;
}

/**
 * JSON スキーマの部品。Gemini は OpenAPI の一部を受け取ります。
 * propertyOrdering を付けないと、モデルが鍵の順を入れ替えて返すことがあり、
 * そのぶん出力が不安定になります。
 */
const S = {
  str: (description) => ({ type: "STRING", description }),
  strList: (description) => ({ type: "ARRAY", items: { type: "STRING" }, description }),
  enum: (values, description) => ({ type: "STRING", enum: values, description }),
};

/** 応答に付いてくる出典（検索を使った場合）。 */
export function extractSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const out = [];
  const seen = new Set();
  for (const c of chunks) {
    const uri = c?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push({ title: String(c.web.title ?? uri).slice(0, 80), url: uri });
  }
  const queries = data?.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];
  return { sources: out.slice(0, 8), queries: queries.slice(0, 5) };
}

/**
 * 自分で立てたサーバーへ投げます（OpenAI 互換の chat/completions）。
 *
 * Ollama・vLLM・llama.cpp・LM Studio が、どれもこの形を話します。
 * Gemini とは体裁が違うだけで、こちらがしたいことは同じです。
 *
 * `response_format: {type:"json_object"}` は、対応していれば効きます。
 * 対応していないサーバーでは無視されるので、渡して害はありません。
 * 形の保証にはならないので、読めなければ callModelJson が聞き直します。
 */
async function callLocal(prompt, opts = {}) {
  const { signal, temperature = 0.4, topP, schema } = opts;
  const url = endpointFor("local:generate", {}, net());
  const body = {
    model: LOCAL_MODEL,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
    temperature,
    stream: false,
  };
  if (Number.isFinite(topP)) body.top_p = topP;
  if (schema) body.response_format = { type: "json_object" };

  const res = await meteredFetch("gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  // 自分で立てたモデルは検索をしないので、出典はありません。
  // 前回の呼び出しの出典が残ったままにならないよう、必ず空に戻します。
  lastSources = { sources: [], queries: [] };
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

async function callOnce(model, prompt, opts = {}) {
  const { signal } = opts;
  const cfg = net();
  const url = endpointFor("gemini:generate", { model }, cfg);
  const res = await meteredFetch("gemini", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...keyHeaders("gemini", cfg),
    },
    body: JSON.stringify(buildModelRequest(prompt, opts)),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  lastSources = extractSources(data);
  return text;
}

// 直近の呼び出しで使われた出典。画面に「どこから得た情報か」を出します。
let lastSources = { sources: [], queries: [] };

export function lastGrounding() {
  return lastSources;
}

/**
 * モデルを呼んで、JSON として読み取ります。
 *
 * 構造化出力を使っていても、混雑時に切り詰められた応答が返ることがあります。
 * そこで黙って諦めると、AIを設定しているのに語句検索の結果が出ます。
 * 壊れていたら一度だけ、温度を下げて作り直させます。
 */
export async function callModelJson(prompt, opts = {}) {
  const raw = await callModel(prompt, opts);
  try {
    return extractJson(raw);
  } catch (e) {
    const retry = await callModel(
      `${prompt}\n\n前回の応答は JSON として読めませんでした（${e.message}）。`
      + "指定した形の JSON だけを、もう一度返してください。",
      { ...opts, temperature: 0 });
    return extractJson(retry);
  }
}

/**
 * モデルを呼びます。存在しないID（404）や不正な引数（400）は
 * 次の候補へ進みます。それ以外のエラーはそのまま投げます。
 */
export async function callModel(prompt, opts = {}) {
  if (usingLocalModel()) {
    // 検索は使えません。呼び出し側が search を渡してきても外します。
    // 黙って無視すると、「調べたつもりの推測」が返ります。
    const { search: _drop, ...rest } = opts;
    resolved = LOCAL_MODEL;
    return callLocal(prompt, rest);
  }
  if (!hasApiKey()) {
    throw new Error("AIのキーが未設定です（⚙ 設定 → 開発者向け から入力できます）");
  }

  let lastErr = null;
  for (const model of modelCandidates()) {
    try {
      const text = await callOnce(model, prompt, opts);
      if (resolved !== model) {
        resolved = model;
        if (!triedOnce || model !== MODEL) {
          console.info(`[ai] 使用モデル: ${model}`
            + (model === MODEL ? "" : `（指定の ${MODEL} は使えませんでした）`));
        }
        triedOnce = true;
      }
      return text;
    } catch (e) {
      lastErr = e;
      // モデルが存在しない/使えない場合だけ次を試す
      if (e.status === 404 || e.status === 400) continue;
      throw e;
    }
  }
  throw lastErr ?? new Error("利用できるモデルがありません");
}

// --- JSON の取り出し --------------------------------------------------------
// 構造化出力に対応しないモデルでも動くよう、返答から最初の完全な JSON を拾います。

export function extractJson(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new SyntaxError("空の応答です");
  try { return JSON.parse(text); } catch { /* 続行 */ }

  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(unfenced); } catch { /* 続行 */ }

  const start = unfenced.indexOf("{");
  if (start < 0) throw new SyntaxError("JSON が含まれていません");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < unfenced.length; i++) {
    const c = unfenced[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      return JSON.parse(unfenced.slice(start, i + 1));
    }
  }
  throw new SyntaxError("JSON が閉じていません");
}

// --- 1. 希望の読み取り ------------------------------------------------------

const UNDERSTAND_SCHEMA = {
  type: "OBJECT",
  properties: {
    searchText: S.str("この人が喜びそうな場所の特徴を描写する1〜2文。地名は入れない"),
    interests: { type: "ARRAY",
      items: S.enum(["onsen", "nature", "history", "food", "art", "sea", "city", "view"]) },
    pace: S.enum(["relaxed", "balanced", "packed"]),
    budgetHint: S.enum(["cheap", "normal", "generous"]),
    keywords: S.strList("説明文と照合するための日本語の語（3〜8語）"),
    avoid: S.strList("利用者が明確に避けたいと言ったもの。無ければ空"),
  },
  required: ["searchText", "interests", "pace", "budgetHint", "keywords", "avoid"],
  propertyOrdering: ["searchText", "interests", "pace", "budgetHint", "keywords", "avoid"],
};

const FALLBACK_PLAN = {
  searchText: "日帰りで楽しめる観光地",
  interests: [], pace: "balanced", budgetHint: "normal",
  keywords: ["観光", "名所"], avoid: [],
};

export async function understandRequest(note, interests, hours, opts = {}) {
  const text = String(note ?? "").trim();
  if (!text && interests.length === 0) return { ...FALLBACK_PLAN, interests };
  if (!hasApiKey()) return keywordFallback(text, interests);

  const prompt = [
    "利用者の希望から、旅先を検索するための条件を抽出してください。",
    "",
    `利用可能な時間: 約${Math.round(hours)}時間`,
    `選択済みの興味: ${interests.length ? interests.join(", ") : "（なし）"}`,
    `利用者の言葉: 「${text || "（記述なし）"}」`,
    "",
    "searchText は、この人が喜びそうな場所の特徴を描写する1〜2文にしてください。",
    "地名や施設名は入れないでください（説明文と照合するためです）。",
    "keywords は、収録データの説明文に実際に出てきそうな語にしてください",
    "（「癒される」ではなく「露天風呂」「渓谷」のように、物の名前で）。",
    "avoid には、利用者が明確に断ったものだけを入れてください。",
    "書かれていないことを推測で足さないでください。",
  ].join("\n");

  try {
    // 抽出は当てものではないので、温度は低く固定します。
    const p = await callModelJson(prompt,
      { temperature: 0.1, topP: 0.8, schema: UNDERSTAND_SCHEMA, ...opts });
    return {
      searchText: p.searchText || FALLBACK_PLAN.searchText,
      interests: Array.isArray(p.interests) ? p.interests : interests,
      pace: ["relaxed", "balanced", "packed"].includes(p.pace) ? p.pace : "balanced",
      budgetHint: ["cheap", "normal", "generous"].includes(p.budgetHint)
        ? p.budgetHint : "normal",
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      avoid: Array.isArray(p.avoid) ? p.avoid : [],
    };
  } catch {
    return keywordFallback(text, interests);
  }
}

function keywordFallback(text, interests) {
  // 空白分割は日本語では使えないので、旅行語彙の辞書で抽出します。
  const { keywords, genres, moods } = extractKeywords(text);
  return {
    ...FALLBACK_PLAN,
    searchText: buildSearchText(text, interests),
    interests: [...new Set([...interests, ...genres])],
    keywords: keywords.length ? keywords : FALLBACK_PLAN.keywords,
    pace: moods.some((m) => ["ゆっくり", "のんびり", "まったり", "静か", "癒"]
      .some((x) => m.includes(x))) ? "relaxed" : "balanced",
  };
}

// --- 2. 検索用の埋め込み ----------------------------------------------------

export async function embedQuery(text, opts = {}) {
  // 自分で立てたモデルには、埋め込みの入口を用意していません。
  // 無理に呼ぶより、語句検索に落ちるほうが確かです。
  if (usingLocalModel() || !EMBED_MODEL) return null;
  if (!hasApiKey()) return null;
  try {
    const cfg = net();
    const url = endpointFor("gemini:embed", { model: EMBED_MODEL }, cfg);
    const res = await meteredFetch("embed", url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...keyHeaders("gemini", cfg),
      },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: EMBED_DIM,
      }),
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const values = data?.embedding?.values ?? data?.embeddings?.[0]?.values;
    return values?.length ? Float64Array.from(values) : null;
  } catch {
    return null;
  }
}

// --- 3. 案を出す（1回目） ----------------------------------------------------

/**
 * 候補をモデルに読ませる形にします。
 *
 * 以前は名前と短い説明だけを渡していました。それだと「海が見たい」に
 * 山の展望台が混じります。分類・知名度に加えて、説明文を長めに、
 * ジャンルの札も添えると、選び違いがはっきり減りました。
 */
function describeCandidates(candidates) {
  const tierLabel = { major: "定番", known: "知る人ぞ知る", hidden: "穴場" };
  return candidates.map((c, ri) => {
    const spots = c.spots.map((s, si) => {
      const t = tierLabel[s.spot.fame_tier] ?? "";
      const desc = (s.spot.description || "（説明なし）").slice(0, 140);
      const genres = (s.spot.genres ?? []).slice(0, 3).join("/");
      const tags = [s.spot.category, t, genres].filter(Boolean).join(" / ");
      return `    ${ri + 1}-${si + 1}. id=${s.spot.id} 「${s.spot.name}」[${tags}]\n`
        + `        ${desc}`;
    }).join("\n");
    const head = `  [エリア${ri + 1}] regionId=${c.region.id} 「${c.region.name}」`
      + `（${c.region.prefecture}） 最寄駅:${c.region.station || "不明"}`
      + ` 収録${c.spots.length}か所`;
    return `${head}\n${spots}`;
  }).join("\n\n");
}

const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    regionIds: { type: "ARRAY", items: { type: "STRING" },
      description: "候補にある regionId を、訪れる順に" },
    headline: S.str("旅程の見出し（20字程度）"),
    rationale: S.str("この旅先を選んだ理由（2文）"),
    picks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          spotId: S.str("候補にある id をそのまま"),
          reason: S.str("この人にとってなぜ良いか（30字程度）"),
        },
        required: ["spotId", "reason"],
        propertyOrdering: ["spotId", "reason"],
      },
    },
  },
  required: ["regionIds", "headline", "rationale", "picks"],
  propertyOrdering: ["regionIds", "headline", "rationale", "picks"],
};

const PLAN_SHAPE = `{
  "regionIds": ["候補にある regionId", "..."],
  "headline": "旅程の見出し（20字程度）",
  "rationale": "この旅先を選んだ理由（2文）",
  "picks": [{ "spotId": "候補にある id", "reason": "選んだ理由（30字程度）" }]
}`;

/**
 * 候補から旅先とスポットを選ばせます。
 * @param {string} [feedback] 前回の検証で見つかった問題（2回目の呼び出し用）
 */
export async function proposePlan(candidates, plan, note, maxSpots, tierTargets,
                                  feedback = "", opts = {}) {
  if (!candidates.length) throw new Error("条件に合う旅先が見つかりませんでした。");
  const maxRegions = Math.max(1, opts.maxRegions ?? 1);
  const days = Math.max(1, opts.days ?? 1);
  // 絶対条件と希望条件は分けて渡します。混ぜると、モデルが
  // 「静かな場所がいい」と「ここには必ず行く」を同じ重みで扱います。
  const mustIds = new Set(opts.mustSpotIds ?? []);
  const avoidIds = new Set(opts.avoidSpotIds ?? []);

  const fallback = () => {
    // 絶対条件のスポットを含むエリアを最優先で入れる
    const mustFirst = candidates.filter((c) =>
      c.spots.some((s) => mustIds.has(s.spot.id)));
    const rest = candidates.filter((c) => !mustFirst.includes(c));
    const chosen = [...mustFirst, ...rest].slice(0, maxRegions);
    const perRegion = Math.max(1, Math.ceil(maxSpots / chosen.length));
    const picks = [];
    const taken = new Set();
    for (const c of chosen) {
      for (const s of c.spots) {
        if (!mustIds.has(s.spot.id) || taken.has(s.spot.id)) continue;
        taken.add(s.spot.id);
        picks.push({ spotId: s.spot.id, regionId: c.region.id,
                     reason: "必ず行くと指定された場所です", tier: s.spot.fame_tier,
                     pinned: true });
      }
    }
    for (const c of chosen) {
      let n = 0;
      for (const s of c.spots) {
        if (n >= perRegion) break;
        if (taken.has(s.spot.id) || avoidIds.has(s.spot.id)) continue;
        taken.add(s.spot.id);
        n++;
        picks.push({ spotId: s.spot.id, regionId: c.region.id,
                     reason: "ご希望に近い場所です", tier: s.spot.fame_tier });
      }
    }
    const names = joinAreaNames(chosen.map((c) => c.region.name));
    return {
      regionIds: chosen.map((c) => c.region.id),
      regionId: chosen[0].region.id,
      headline: `${names}をめぐる旅`,
      rationale: chosen.length > 1
        ? `${names}を順にめぐります。ご希望に近い場所が集まっているエリアを、`
          + "移動が少なくなる順に並べました。"
        : `${chosen[0].region.prefecture}の${names}。`
          + "ご希望に近い場所が集まっているエリアです。",
      picks: picks.slice(0, maxSpots),
      fromModel: false,
    };
  };
  if (!hasApiKey()) return fallback();

  const areaRule = maxRegions > 1
    ? `・${days}日間の旅なので、拠点を移しながら1〜${maxRegions}エリアを回ります。`
      + "regionIds に訪れる順で並べてください（1エリアに留まるほうが"
      + "良いと判断したなら1つだけでも構いません）。"
    : "・regionIds にはエリアを1つだけ入れてください。";

  const prompt = [
    `下の候補から旅先を選び、訪れるスポットを${maxSpots}か所選んでください。`,
    "少なく選ぶより、上限まで選んでください。行き先が少ない旅程は",
    "「せっかく来たのに空いた時間ができた」になります。",
    "入りきらないぶんは、あとでプログラムが削ります。",
    "",
    `利用者の希望: 「${note || "（記述なし）"}」`,
    `雰囲気: ${plan.searchText}`,
    `ペース: ${plan.pace}`,
    `日数: ${days}日`,
    plan.avoid?.length ? `避けたいもの: ${plan.avoid.join("、")}` : "",
    "",
    mustIds.size ? "【絶対条件】必ず守ってください。" : "",
    mustIds.size ? `・次のIDは必ず picks に含めること: ${[...mustIds].join(", ")}`
      + "（これらが含まれるエリアを選んでください）" : "",
    avoidIds.size ? `・次のIDは使わないこと: ${[...avoidIds].join(", ")}` : "",
    mustIds.size || avoidIds.size ? "" : "",
    "【希望条件】できるだけ沿ってください。",
    `・定番${tierTargets.major}か所、知る人ぞ知る${tierTargets.known}か所、`
      + `穴場${tierTargets.hidden}か所を目安に混ぜること。`,
    areaRule,
    "・候補にある id だけを使い、存在しない場所を作らないこと。",
    "・picks は訪問する順に並べ、エリアごとにまとめること",
    "（regionIds の順に、そのエリアのスポットを続けて並べる）。",
    `・${days}日ぶんの予定になるよう、1日あたり${Math.max(3, Math.round(maxSpots / days))}`
      + "か所を目安に選ぶこと。",
    "・同じような場所ばかりにしないこと（寺だけ、展望台だけ、にしない）。",
    "・利用者の言葉に地名や施設名があれば、それに当たる候補を必ず入れること。",
    "・reason には、その人の希望のどこに応えているかを書くこと。",
    "　どの場所にも書ける文（「有名です」「人気です」）は書かないこと。",
    feedback ? `\n${feedback}` : "",
    "",
    "候補:",
    describeCandidates(candidates),
    "",
    "次の形の JSON だけを返してください。",
    PLAN_SHAPE,
  ].filter(Boolean).join("\n");


  let raw;
  try {
    // 選定は好みの問題なので温度を残しますが、以前の 0.6 は
    // 「候補にある id」を書き崩すことがありました。
    raw = await callModelJson(prompt,
      { temperature: 0.35, topP: 0.9, schema: PLAN_SCHEMA, thinking: 2048, ...opts });
  } catch {
    return fallback();
  }

  // モデルが選んだエリア（候補にあるものだけ、順序は保つ）
  const byId = new Map(candidates.map((c) => [c.region.id, c]));
  const rawIds = Array.isArray(raw?.regionIds)
    ? raw.regionIds : [raw?.regionId].filter(Boolean);
  const chosen = [];
  for (const id of rawIds) {
    const c = byId.get(id);
    if (c && !chosen.includes(c)) chosen.push(c);
    if (chosen.length >= maxRegions) break;
  }
  if (!chosen.length) return fallback();

  // 候補に存在するIDだけを採用する（作り話を通さない最後の関門）
  const allowed = new Map();
  for (const c of chosen) {
    for (const s of c.spots) allowed.set(s.spot.id, { spot: s.spot, regionId: c.region.id });
  }
  const seen = new Set();
  const picks = [];
  // 絶対条件は、モデルが落としていても必ず入れる
  for (const [id, hit] of allowed) {
    if (!mustIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    picks.push({ spotId: id, regionId: hit.regionId, pinned: true,
                 reason: "必ず行くと指定された場所です",
                 tier: hit.spot.fame_tier });
  }
  for (const p of raw.picks ?? []) {
    const hit = allowed.get(p?.spotId);
    if (!hit || seen.has(hit.spot.id) || avoidIds.has(hit.spot.id)) continue;
    seen.add(hit.spot.id);
    picks.push({
      spotId: hit.spot.id,
      regionId: hit.regionId,
      reason: String(p.reason ?? "ご希望に近い場所です").slice(0, 60),
      tier: hit.spot.fame_tier,
    });
    if (picks.length >= maxSpots) break;
  }
  // 足りなければ、選ばれたエリアから順に埋める
  for (const c of chosen) {
    for (const s of c.spots) {
      if (picks.length >= maxSpots) break;
      if (seen.has(s.spot.id) || avoidIds.has(s.spot.id)) continue;
      seen.add(s.spot.id);
      picks.push({ spotId: s.spot.id, regionId: c.region.id,
                   reason: "ご希望に近い場所です", tier: s.spot.fame_tier });
    }
  }
  if (!picks.length) return fallback();

  // エリアの並び順に picks をまとめ直す（モデルが混ぜて返してきても崩れない）
  const orderIndex = new Map(chosen.map((c, i) => [c.region.id, i]));
  picks.sort((a, b) => (orderIndex.get(a.regionId) ?? 0) - (orderIndex.get(b.regionId) ?? 0));

  const names = joinAreaNames(chosen.map((c) => c.region.name));
  return {
    regionIds: chosen.map((c) => c.region.id),
    regionId: chosen[0].region.id,
    headline: String(raw.headline || `${names}をめぐる旅`).slice(0, 40),
    rationale: String(raw.rationale || "").slice(0, 200)
      || `${names}周辺にご希望に合う場所が集まっています。`,
    picks,
    fromModel: true,
  };
}

// --- 4. スポットの説明 ------------------------------------------------------

export async function describeSpot(spot, opts = {}) {
  if (!hasApiKey()) return spot.description ?? "";
  const prompt = [
    "次の場所について、旅行者向けに3〜4文で紹介してください。",
    "与えられた情報の範囲で書き、事実を追加しないでください。",
    "説明文だけを返してください。",
    "",
    `名前: ${spot.name}`,
    `分類: ${spot.category}`,
    `場所: ${spot.prefecture ?? ""} ${spot.region ?? ""}`,
    `説明: ${spot.description || "（詳細な説明なし）"}`,
  ].join("\n");
  try {
    return (await callModel(prompt, { temperature: 0.7, ...opts }))
      || spot.description || "";
  } catch {
    return spot.description ?? "";
  }
}
