// 旅さき — 管理画面
//
// 旅行者向けの画面から、技術の言葉を全部こちらへ移しました。
// 「Gemini」「Routes API」「知識ベース」は、運用する人の言葉です。
//
// ここが答えるのは4つだけです。
//   1. どのデータが、どれだけ、どこから入っているか
//   2. 外部サービスに繋がるか
//   3. どれだけ呼んだか（課金に効く）
//   4. データがどれくらい古いか
//
// **認証はありません。** 公開する場所には置かないでください。

import { EMBED_MODEL, FALLBACK_MODELS, GEMINI_API_KEY, KB_INDEX_URL,
         LOCAL_BASE_URL, LOCAL_MODEL, MAPS_API_KEY, MODEL, MODEL_PROVIDER,
         PROXY_URL, USE_ROUTES_API } from "../js/config.js";
import { loadKnowledgeBase } from "../js/kb.js";
import { diagnoseGeminiKey } from "../js/ai.js";
import { diagnoseMapsKey } from "../js/routes.js";
import { describeUsage, quota } from "../js/quota.js";
import { freshnessOf } from "../js/confidence.js";

const app = document.getElementById("app");

/** 要素を1つ作る。ui.js と同じ考えかたで、文字しか入れません。 */
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const row = (k, v, extra) => el("div", { class: "row" },
  el("span", { class: "k" }, k),
  el("span", { class: `v${extra === "mono" ? " mono" : ""}` }, v));

const pill = (text, kind) => el("span", { class: `pill ${kind}` }, text);

/** 数の偏りを、棒で見せます。数字だけだと気づけません。 */
function bars(pairs) {
  const max = Math.max(1, ...pairs.map(([, n]) => n));
  return el("div", { class: "bars" }, pairs.map(([name, n]) =>
    el("div", { class: "bar-row" },
      el("span", { class: "n" }, name),
      el("span", { class: "t" }, el("i", { style: `width:${n / max * 100}%` })),
      el("span", { class: "c" }, n.toLocaleString()))));
}

async function main() {
  const out = el("div");

  // --- 1. データ ----------------------------------------------------------
  out.append(el("h2", {}, "収録データ"));
  const dataCard = el("div", { class: "card" });
  out.append(dataCard);

  let kb = null;
  try {
    kb = await loadKnowledgeBase();
  } catch (e) {
    dataCard.append(row("読み込み", `失敗しました（${e.message}）`));
  }

  if (kb) {
    const c = kb.manifest?.counts ?? {};
    dataCard.append(
      row("出どころ", KB_INDEX_URL || "同梱データ（KB_INDEX_URL 未設定）", "mono"),
      row("エリア", (c.regions ?? kb.regions.length).toLocaleString() + " 件"),
      row("スポット", (c.spots ?? kb.spots.length).toLocaleString() + " 件"),
      row("実際に読めた件数", kb.spots.length.toLocaleString() + " 件"));

    // 申告と実数が合わないのは、シャードの形が違うときに起きます。
    // 件数だけ増えて中身が入っていない、という事故を見つけるための行です。
    if (c.spots && c.spots !== kb.spots.length) {
      dataCard.append(el("p", { class: "note danger" },
        `index.json は ${c.spots.toLocaleString()}件 と書いていますが、`
        + `実際に読めたのは ${kb.spots.length.toLocaleString()}件 です。`
        + "シャードの形（{\"spots\": [...]}）を確かめてください。"));
    }

    // 分類の内訳
    const byCat = new Map();
    for (const s of kb.spots) {
      byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
    }
    const top = [...byCat].sort((a, b) => b[1] - a[1]).slice(0, 12);
    out.append(el("h2", {}, "分類の内訳（上位12）"));
    out.append(el("div", { class: "card" }, bars(top)));

    // 確からしさの内訳
    const bySrc = new Map();
    for (const s of kb.spots) {
      const key = s.source === "ai" ? "AI調査"
        : s.source === "estimated" ? "推定（分類ごとの目安）"
          : "確認済み";
      bySrc.set(key, (bySrc.get(key) ?? 0) + 1);
    }
    out.append(el("h2", {}, "情報の確からしさ"));
    out.append(el("div", { class: "card" },
      bars([...bySrc].sort((a, b) => b[1] - a[1]))));

    // 鮮度
    const stamped = kb.spots.map((s) => s.fetchedAt).filter(Number.isFinite);
    const fresh = stamped.length ? freshnessOf(Math.min(...stamped)) : null;
    out.append(el("h2", {}, "データの鮮度"));
    out.append(el("div", { class: "card" },
      row("確認日を持つ件数",
        `${stamped.length.toLocaleString()} / ${kb.spots.length.toLocaleString()} 件`),
      row("いちばん古いもの", fresh ? fresh.text : "確認日を持つデータがありません")));
    if (!stamped.length) {
      out.append(el("p", { class: "note" },
        "確認日（fetchedAt）を持つスポットがありません。"
        + "「確認済み」と「最新」は別のことなので、"
        + "取り込みのときに確認日を入れておくと、画面で鮮度を出せます。"));
    }

    // 出典（表示が条件のデータを含みます）
    out.append(el("h2", {}, "出典"));
    const srcCard = el("div", { class: "card" });
    for (const s of kb.manifest?.sources ?? kb.attribution ?? []) {
      srcCard.append(row(s.name, s.url
        ? el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.url)
        : "（URLなし）"));
    }
    out.append(srcCard);
    out.append(el("p", { class: "note" },
      "出典の表示が利用条件になっているデータを含みます。"
      + "旅程の画面からも消さないでください。"));
  }

  // --- 2. 外部サービス -----------------------------------------------------
  out.append(el("h2", {}, "外部サービス"));
  const svc = el("div", { class: "card" });
  const viaProxy = Boolean(String(PROXY_URL ?? "").trim());
  const local = MODEL_PROVIDER === "local";
  svc.append(
    row("キーの持ちかた", viaProxy
      ? el("span", {}, pill("プロキシ経由", "ok"), " ", PROXY_URL)
      : el("span", {}, pill("ブラウザに直書き", "warn"),
          " 公開するなら PROXY_URL を設定してください")),
    row("モデルの出どころ", local
      ? `自分で立てたサーバー（${LOCAL_MODEL} @ ${LOCAL_BASE_URL}）`
      : `Google（${MODEL}）`),
    row("控えのモデル", local ? "—" : (FALLBACK_MODELS.join(", ") || "なし"), "mono"),
    row("埋め込み", local ? "使いません（語句検索に落ちます）" : EMBED_MODEL, "mono"),
    row("経路API", USE_ROUTES_API
      ? el("span", {}, pill("使う", "ok"))
      : el("span", {}, pill("使わない", "warn"), " 距離からの推定になります")),
    row("Gemini キー", viaProxy ? "サーバー側" : (GEMINI_API_KEY ? "設定済み" : "未設定")),
    row("Maps キー", viaProxy ? "サーバー側" : (MAPS_API_KEY ? "設定済み" : "未設定")));

  // 疎通の確認。押したときだけ呼びます（開くだけで課金しません）。
  const result = el("span", { class: "v" }, "まだ確かめていません");
  const btn = el("button", { class: "act", type: "button" }, "接続を確かめる");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    result.textContent = "確かめています…";
    const lines = [];
    try {
      const ai = await diagnoseGeminiKey();
      lines.push(`AI: ${ai.ok ? "OK" : "NG"} — ${ai.message}`);
    } catch (e) { lines.push(`AI: NG — ${e.message}`); }
    try {
      const r = await diagnoseMapsKey();
      lines.push(`経路: ${r.ok ? "OK" : "NG"} — ${r.message}`);
    } catch (e) { lines.push(`経路: NG — ${e.message}`); }
    result.textContent = lines.join(" / ");
    btn.disabled = false;
  });
  svc.append(el("div", { class: "row" },
    el("span", { class: "k" }, "疎通の確認"), result, btn));
  out.append(svc);
  out.append(el("p", { class: "note" },
    "「接続を確かめる」は、実際に1回ずつ呼びます（課金対象です）。"
    + "開いただけでは呼びません。"));

  // --- 3. 使用量 -----------------------------------------------------------
  out.append(el("h2", {}, "これまでの呼び出し"));
  const q = el("div", { class: "card" },
    row("合計", `${quota.used.toLocaleString()} 回`),
    row("状態", quota.blocked
      ? pill("止めています", "ng") : pill("続けられます", "ok")),
    row("次の確認まで", `あと ${quota.remaining} 回`),
    row("内訳", describeUsage(quota)));
  out.append(q);
  out.append(el("p", { class: "note" },
    "これは**この端末の中だけ**の数です。ブラウザを変えれば0から数え直します。"
    + "サーバー側の上限の代わりにはなりません（server/README.md）。"));

  // --- 4. 気をつけること ---------------------------------------------------
  out.append(el("h2", {}, "公開する前に"));
  const checks = [
    [viaProxy, "PROXY_URL を設定して、キーをブラウザに置かない"],
    [true, "プロキシの ALLOW_ORIGIN を自分のサイトに絞る"],
    [true, "レート制限を有効にする（Cloudflare は Durable Object）"],
    [true, "Google 側でも API キーに制限をかける"],
    [true, "この管理画面を、公開する場所に置かない（認証がありません）"],
  ];
  const ck = el("div", { class: "card" });
  for (const [done, text] of checks) {
    ck.append(row(done ? "済" : "要確認", text));
  }
  out.append(ck);

  app.textContent = "";
  app.append(out);
}

main().catch((e) => {
  app.textContent = "";
  app.append(el("p", { class: "note danger" }, `読み込めませんでした: ${e.message}`));
});
