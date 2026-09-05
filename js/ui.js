// 画面の描画。DOM 操作はここに閉じ込め、ロジックは他のモジュールに任せます。

import { directionsFromHereUrl, linksForItem } from "./links.js";
import { TIER_LABEL } from "./mix.js";
import { profileOf } from "./feasibility.js";
import { crowdLevel } from "./crowd.js";
import { describeHours, hoursFor } from "./hours.js";
import { describeTransit } from "./transit.js";
import { artFor } from "./art.js";
import { confidenceOf, describeSource, freshnessOf, reservationOf }
  from "./confidence.js";
import { paceBreakdown, slackLevel } from "./score.js";
import { VARIANTS } from "./variants.js";
import { qualityOf, spotFit, tripFit } from "./fit.js";
import { currentStep } from "./today.js";
import { photoFor } from "./photos.js";

const ICON = {
  transit: "🚃", spot: "📍", meal: "🍽", lodging: "🛏", free: "☕",
};

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export function fmtTime(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDay(d) {
  return d.toLocaleDateString("ja-JP",
    { month: "long", day: "numeric", weekday: "short" });
}

export function fmtDuration(min) {
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    // html: の逃げ道は置きません。
    //
    // 一度でも innerHTML の入口を作ると、いつか誰かが AI の返答や
    // 外部データをそこへ通します。このアプリは、AIの文・Wikipediaの
    // 抜粋・利用者の入力を画面に出します。全部が入口になり得ます。
    //
    // テキストしか入らない作りにしておけば、その心配ごと自体が
    // 無くなります。強調や改行が要るときは、要素を分けてください。
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// --- 進行状況 ---------------------------------------------------------------

export const STEPS = [
  "ご希望を読み取っています",
  "候補地を探しています",
  "AIが旅程の案を作っています",
  "各スポットの時間を確認しています",
  "確認結果をもとに調整しています",
  "経路と時刻を組み立てています",
];

/**
 * 待っているあいだの画面。
 *
 * 回る輪だけだと、進んでいるのか固まったのかが分かりません。
 * いま何をしていて、あと何が残っているかを、そのまま並べます。
 * ピンが生えて波紋が広がるのは、地図が育っている合図です。
 */
export function renderProgress(container, step, detail = "") {
  container.textContent = "";
  const card = el("div", { class: "plan-card" });
  card.append(
    el("p", { class: "step-text" }, "旅を組み立てています"),
    el("p", { class: "step-detail" },
      detail || STEPS[Math.min(step, STEPS.length - 1)]),
    el("div", { class: "md-progress", role: "progressbar",
                "aria-valuenow": String(step + 1),
                "aria-valuemin": "1", "aria-valuemax": String(STEPS.length) },
      el("i", { style: `width:${((step + 1) / STEPS.length) * 100}%` })),
    el("ul", { class: "step-list" },
      STEPS.map((s, i) => el("li", {
        class: i < step ? "done" : i === step ? "active" : "",
      }, el("span", { class: "dot" }),
         el("span", {}, `${i < step ? "✓ " : ""}${s}`)))),
  );
  container.append(card);
}

// --- 旅程 -------------------------------------------------------------------

export function renderItinerary(container, itin, trip, handlers = {}) {
  container.textContent = "";

  // 出す順を、読む順に合わせます。
  //
  // 以前は、作った順（要約→適合度→ペース→出典→点数→混雑→費用→…→旅程）
  // に積んでいました。豪華ではあるのですが、旅行者が最初に見たいのは
  // 「で、何時にどこへ行くのか」です。それが20個の分析パネルの下に
  // あると、たどり着く前に読むのをやめます。
  //
  //   要約 → 3案 → 旅程 → 言葉で直す → （折りたたみ）詳しく見る
  //
  // 分析は消しません。畳んでおくだけです。
  const detail = [];
  let adjustBox = null;
  let talkBox = null;
  let variantsBox = null;

  const nights = itin.days.length - 1;
  const title = itin.title ?? itin.regionName;
  // 見出しと同じことを繰り返さない（AIが見出しを付けなかった場合の控え）
  const sub = itin.headline && !itin.headline.startsWith(title)
    ? itin.headline : itin.prefecture;

  container.append(...[
    el("header", { class: "itin-head" },
      el("h2", {}, title),
      el("p", { class: "sub" }, sub),
      itin.stays?.length > 1
        ? el("p", { class: "stay-line" },
            itin.stays.map((s) => `${s.name} ${s.days}日`).join(" → "))
        : null),
  ].filter(Boolean));

  // 判断を、数字より先に置きます。
  //
  // 「無理のなさ 82/100」だけを見せても、82が良いのか悪いのかは
  // 読み手には決められません。まず「ゆとりあり」と言い切って、
  // 数字はその根拠として添えます。
  const verdict = summaryVerdict(itin);

  container.append(...[
    el("div", { class: "summary" },
      verdict
        ? el("p", { class: `verdict lv-${verdict.level}` },
            el("strong", {}, verdict.label),
            el("span", {}, verdict.detail))
        : null,
      itin.rationale ? el("p", { class: "why" }, itin.rationale) : null,
      el("div", { class: "stats" },
        stat(nights > 0 ? `${nights}泊${nights + 1}日` : "日帰り", "日程"),
        stat(`${itin.spotCount}か所`, "立ち寄り"),
        nights > 0
          ? stat(fmtDuration(sightseeingMinutes(itin)), "見学の合計")
          : stat(fmtDuration(tripMinutes(itin)), "所要"),
        itin.cost
          ? stat(`¥${itin.cost.total.toLocaleString()}`, "概算費用")
          : stat(itin.usedRoutesApi ? "実経路" : "推定", "移動時間"))),
  ].filter(Boolean));

  // 0. 旅の意味づけ。時刻表の前に、この並びに意味があることを伝えます。
  //    決まった文しか出しません（AIに書かせると毎回変わります）。
  if (itin.story?.length) {
    container.append(el("section", { class: "panel story" },
      el("h3", {}, "この旅の流れ"),
      el("ul", { class: "panel-list" },
        itin.story.map((t, i) => el("li", {},
          itin.days.length > 1 ? `${i + 1}日目 — ${t}` : t)))));
  }

  // 1. 3案。旅行に唯一の正解はないので、並べて選んでもらいます。
  //    ただし「どれがおすすめか」は言います。放り出さないこと。
  if (itin.variants?.length > 1 && handlers.onVariant) {
    const box = el("section", { class: "panel variants" });
    variantsBox = box;
    // 「3つの案から選べます」だけだと、選ぶ材料がありません。
    // どれを推すのかを見出しで先に言います。
    const rec = VARIANTS[itin.recommendKey]?.label;
    box.append(el("h3", {}, rec
      ? `あなたには「${rec}」がおすすめです`
      : "3つの案から選べます"));

    const cards = el("div", { class: "variant-cards" });
    for (const v of itin.variants) {
      const def = VARIANTS[v.key] ?? {};
      const card = el("button", {
        type: "button",
        class: `variant md-state${v.key === itin.variantKey ? " is-selected" : ""}`,
        "aria-pressed": v.key === itin.variantKey ? "true" : "false",
      });
      // append は null をそのまま「null」という文字として入れます。
      // 条件つきの要素は、必ずここで落とします。
      //
      // 並べる順は、選ぶときに見る順です。
      //   名前 → 何が違うか → 中身（何か所・移動） → 点
      // 以前は点をいちばん上に大きく出していました。66と68を
      // 見比べても、どちらが自分に合うかは決められません。
      card.append(...[
        el("span", { class: "v-head" },
          el("span", { class: "v-ic", "aria-hidden": "true" }, def.icon ?? "•"),
          el("b", { class: "v-name" }, def.label ?? v.key),
          v.key === itin.recommendKey
            ? el("span", { class: "v-badge" }, "おすすめ") : null),
        v.distinct ? el("span", { class: "v-distinct" }, v.distinct) : null,
        el("span", { class: "v-sum" }, v.summary ?? ""),
        el("span", { class: "v-blurb" }, def.blurb ?? ""),
        Number.isFinite(v.score)
          ? el("span", { class: "v-score" }, `無理のなさ ${v.score}`)
          : null,
      ].filter(Boolean));
      card.addEventListener("click", () => handlers.onVariant(v.key));
      cards.append(card);
    }
    box.append(cards);
    if (itin.recommendWhy) {
      box.append(el("p", { class: "variant-why" }, itin.recommendWhy));
    }
  }

  // 2. なぜこの旅程なのか。軸ごとの点で説明します。
  if (itin.fit) {
    detail.push(el("section", { class: "panel fit" },
      el("div", { class: "panel-head" },
        el("h3", {}, "ご希望との適合度"),
        el("span", { class: "fit-total" },
          el("b", {}, String(itin.fit.total)), el("i", {}, "/100"))),
      el("p", { class: "score-summary" }, itin.fit.summary),
      axisList(itin.fit.axes),
      el("p", { class: "fine" },
        "ご希望のジャンル・移動のしやすさ・混雑の避けやすさ・"
        + "定番と穴場のバランスから、こちらで計算しています"
        + "（AIの採点ではありません）。")));
  }

  // 3. 帰りの余裕と、旅のペース。
  //    「成立している」と「安心して行ける」は別です。
  if (itin.slack || itin.pace) {
    const box = el("section", { class: "panel pace" });
    box.append(el("h3", {}, "この旅のペース"));
    if (itin.slack && itin.slack.level !== "unknown") {
      box.append(el("div", { class: `slack slack--${itin.slack.level}` },
        el("span", { class: "sl-num" }, fmtDuration(itin.slack.minutes)),
        el("span", { class: "sl-body" },
          el("span", { class: "sl-label" },
            `帰りの余裕 — ${itin.slack.label}`),
          el("p", { class: "sl-text" }, itin.slack.text))));
    }
    if (itin.pace?.rows?.length) {
      box.append(el("div", { class: "pace-bar", role: "img",
        "aria-label": itin.pace.rows
          .map((r) => `${r.label} ${fmtDuration(r.minutes)}`).join("、") },
        itin.pace.rows.map((r) =>
          el("i", { class: r.key, style: `width:${r.share}%` }))));
      box.append(el("ul", { class: "pace-legend" },
        itin.pace.rows.map((r) => el("li", {},
          el("span", { class: `dot ${r.key}` }),
          el("b", {}, r.label),
          el("span", {}, fmtDuration(r.minutes))))));
      if (itin.pace.walkKm > 0) {
        box.append(el("p", { class: "fine" },
          `歩く距離はあわせて約 ${itin.pace.walkKm}km です。`));
      }
    }
    detail.push(box);
  }

  // 4. 情報の確からしさ。出どころの違うものを、同じ顔で並べないこと。
  if (itin.sourceMix) {
    detail.push(el("section", { class: "panel sources-mix" },
      el("div", { class: "panel-head" },
        el("h3", {}, "この旅程の情報について"),
        srcChip(itin.sourceMix)),
      el("p", { class: "score-summary" }, itin.sourceMix.text),
      // 何が起きているかを言うだけでなく、どうすればいいかまで書きます。
      // 「AI調査」だけを見せると、「AIが適当に言っている？」と
      // 受け取られます。言いたいのは「まだ裏が取れていない」です。
      itin.sourceMix.action
        ? el("p", { class: "src-action" }, itin.sourceMix.action) : null,
      el("ul", { class: "panel-list" },
        [["🟢 確認済み", "収録データの実測値、または経路検索で取れた値です。"],
         ["🟡 推定", "分類ごとの目安、または距離からの計算です。"],
         ["🟠 AI調査", "AIが検索して得た情報で、公式では確認できていません。"
                     + "訪問前に公式サイトでご確認ください。"]]
          .map(([k, v]) => el("li", {}, `${k} … ${v}`))),
      // 「確認済み」と「最新」は別です。いつ取ったものかを併記します。
      itin.freshness
        ? el("p", { class: `freshness lv-${itin.freshness.level}` },
            itin.freshness.text)
        : null));
  }

  // 旅程の質。AIの自己採点ではなく、こちらで数えた値です。
  // 何点かより「どこが弱いか」が読めることを優先します。
  if (itin.score) {
    const sc = itin.score;
    detail.push(...[el("section", { class: `panel score lv-${scoreClass(sc.total)}` },
      el("div", { class: "panel-head" },
        el("h3", {}, "この旅程の無理のなさ"),
        el("span", { class: "score-total" },
          el("b", {}, String(sc.total)), el("i", {}, "/100"))),
      el("p", { class: "score-summary" }, sc.summary),
      // 疲労は目盛りで出します。「55点」より「やや疲れる」のほうが、
      // 行くか行かないかの判断に使えます。
      el("div", { class: `fatigue lv-${fatigueClass(sc.fatigue)}` },
        el("span", { class: "fg-label" }, "疲労の見込み"),
        el("span", { class: "fg-bar", role: "img",
                     "aria-label": `疲労 ${sc.fatigue} / 100（${sc.fatigueLabel}）` },
          el("i", { style: `width:${sc.fatigue}%` })),
        el("span", { class: "fg-word" }, sc.fatigueLabel)),
      sc.tooHard
        ? el("p", { class: "fg-warn" },
            "この旅程は人にはきつい部類です。"
            + "「もっとゆっくり」で立ち寄りを減らすことをおすすめします。")
        : null,
      el("ul", { class: "score-parts" },
        sc.parts.map((p) => el("li", { class: p === sc.weakest ? "weak" : "" },
          el("span", { class: "sp-label" }, p.label),
          el("span", { class: "sp-bar", role: "img",
                       "aria-label": `${p.label} ${p.score}点` },
            el("i", { style: `width:${p.score}%` })),
          el("span", { class: "sp-num" }, String(p.score)),
          el("span", { class: "sp-note" }, p.note)))),
      el("p", { class: "fine" },
        "移動時間・歩き続ける長さ・日ごとのばらつき・希望との合い方から、"
        + "こちらで計算しています（AIの採点ではありません）。"))].filter(Boolean));
  }

  // 混雑の見込み。実測ではないことを、数字の隣に必ず書きます。
  if (itin.crowd?.perSpot?.length) {
    const c = itin.crowd;
    detail.push(el("section", { class: `panel crowd lv-${levelClass(c.score)}` },
      el("div", { class: "panel-head" },
        el("h3", {}, "混雑の見込み"),
        el("span", { class: "crowd-badge" }, c.label)),
      el("div", { class: "meter", role: "img",
                  "aria-label": `混雑の見込み ${c.score} / 100（${c.label}）` },
        el("i", { style: `width:${c.score}%` })),
      el("ul", { class: "panel-list" },
        c.notes.map((n) => el("li", {}, n))),
      el("p", { class: "fine" },
        "知名度・曜日・時間帯・季節・場所の性格からの推定です（実測ではありません）。")));
  }

  // 費用の内訳
  if (itin.cost?.rows?.length) {
    detail.push(el("section", { class: "panel cost-panel" },
      el("div", { class: "panel-head" },
        el("h3", {}, "この旅のお金の目安"),
        el("span", { class: "cost-total" }, `¥${itin.cost.total.toLocaleString()}`)),
      el("ul", { class: "cost-rows" },
        itin.cost.rows.map((r) => el("li", {},
          el("span", { class: "cr-label" }, r.label),
          el("span", { class: "cr-bar" },
            el("i", { style: `width:${Math.round(r.yen / itin.cost.total * 100)}%` })),
          el("span", { class: "cr-yen" }, `¥${r.yen.toLocaleString()}`),
          el("span", { class: "cr-note" }, r.note)))),
      el("p", { class: "fine" },
        "交通費は距離からの概算、宿泊費は分類ごとの目安です。"
        + "実際の運賃・宿泊費とは差が出ます。予算を決めるときは、"
        + "少し多めに見ておいてください。")));
  }

  // 希望に応えられたかどうか（応えられていれば何も出さない）
  if (itin.coverage && itin.coverage.level !== "ok") {
    const box = el("section", { class: `panel coverage ${itin.coverage.level}` },
      el("h3", {}, itin.coverage.level === "miss"
        ? "ご希望に合う場所が見つかりませんでした"
        : "ご希望の場所は、今回の旅程には入りませんでした"),
      el("p", {}, itin.coverage.text));
    if (itin.coverage.alternatives?.length) {
      box.append(el("div", { class: "alt" },
        itin.coverage.alternatives.map((s) => el("span", {}, s.name))));
    }
    detail.push(box);
  }

  if (itin.verifyNote) {
    detail.push(el("section", { class: "panel verify-note" },
      el("h3", {}, itin.verifyNote.includes("が案を作成")
        ? "AIの案を検証しました" : "案を検証しました"),
      el("p", {}, itin.verifyNote)));
  }

  // その時期ならではのこと。9月の京都と11月の京都は別の旅です。
  if (itin.seasonNotes?.length) {
    detail.push(el("section", { class: "panel season" },
      el("h3", {}, "この時期について"),
      el("ul", { class: "panel-list" },
        itin.seasonNotes.map((t) => el("li", {}, t)))));
  }

  // 荷物。旅程の時刻は合っているのに現地でつらい、という差がここに出ます。
  if (itin.luggage?.days?.length) {
    const box = el("section", { class: "panel luggage" });
    box.append(el("h3", {}, "荷物をどうするか"),
               el("p", { class: "score-summary" }, itin.luggage.summary));
    for (const day of itin.luggage.days) {
      box.append(el("ul", { class: "panel-list" },
        day.options.map((o) => el("li", {},
          el("b", {}, `${o.label} — `), o.text))));
    }
    box.append(el("p", { class: "fine" },
      "ロッカーの空き状況までは分かりません。"
      + "大きい荷物用は数が少ないので、朝のうちが確実です。"));
    detail.push(box);
  }

  // 営業時間まわりの注意。定休日が確認できていない施設をここに出します。
  if (itin.hoursWarnings?.length) {
    detail.push(el("section", { class: "panel notes hours-notes" },
      el("h3", {}, "営業時間のご確認をおすすめします"),
      el("ul", { class: "panel-list" },
        itin.hoursWarnings.map((w) => el("li", {}, w)))));
  }

  if (itin.warnings?.length) {
    detail.push(el("section", { class: "panel notes" },
      el("h3", {}, "お伝えしておくこと"),
      el("ul", { class: "panel-list" },
        itin.warnings.map((w) => el("li", {}, w)))));
  }

  // どこから得た情報かを示します。検索で調べた場合だけ出ます。
  if (itin.sources?.length) {
    detail.push(el("section", { class: "panel sources" },
      el("h3", {}, "調べたときに参照したページ"),
      el("ul", { class: "src-list" },
        itin.sources.map((s) => el("li", {},
          el("a", { href: s.url, target: "_blank", rel: "noreferrer" },
             s.title)))),
      el("p", { class: "fine" },
        "AIが検索して得た情報です。営業時間・料金は必ず公式でご確認ください。")));
  }

  // この旅程の弱点。AIに自己採点させるのではなく、こちらで計算しています。
  if (itin.critique?.length) {
    detail.push(el("section", { class: "panel critique" },
      el("h3", {}, "この旅程について"),
      el("ul", {}, itin.critique.map((c) =>
        el("li", { class: c.level },
          el("span", { class: "c-label" }, c.label),
          el("span", { class: "c-text" }, c.text))))));
  }

  if (itin.suggestions?.length && handlers.onSuggest) {
    detail.push(el("section", { class: "panel relax" },
      el("h3", {}, "この旅をもっと成立させるには"),
      el("div", { class: "relax-list" },
        itin.suggestions.map((s) => suggestionButton(s, handlers.onSuggest)))));
  }

  // 天気・日没・混雑からの見直し。**黙って変えません。**
  // 雨だからと勝手に行き先を差し替えられたら、楽しみにしていた場所が
  // 理由も分からず消えます。理由を添えて出し、押されたら組み直します。
  const rp = itin.replan;
  if (rp && (rp.suggestions?.length || rp.days?.length || rp.notes?.length)) {
    const box = el("section", { class: "panel replan" });
    box.append(...[el("div", { class: "panel-head" },
      el("h3", {}, "天気・日没・混雑から見ると"),
      rp.suggestions?.length
        ? el("span", { class: "replan-count" },
            `${rp.suggestions.length}件`)
        : null)].filter(Boolean));

    if (rp.days?.length) {
      box.append(el("ul", { class: "panel-list weather-days" },
        rp.days.map((t) => el("li", {}, t))));
    }

    const picked = new Set();
    if (rp.suggestions?.length) {
      const list = el("ul", { class: "replan-list" });
      for (const s of rp.suggestions) {
        const li = el("li", { class: `rp ${s.kind}` });
        const label = el("label", { class: "rp-pick" });
        const box2 = el("input", { type: "checkbox" });
        box2.addEventListener("change", () => {
          if (box2.checked) picked.add(s); else picked.delete(s);
          go.disabled = picked.size === 0;
          go.textContent = picked.size
            ? `選んだ ${picked.size}件で組み直す` : "組み直す";
        });
        label.append(box2,
          el("span", { class: "rp-ic", "aria-hidden": "true" },
            { rain: "☂", sunset: "🌇", crowd: "👥" }[s.kind] ?? "•"),
          el("span", { class: "rp-tx" }, s.text));
        li.append(label);
        list.append(li);
      }
      box.append(list);

      var go = el("button", { class: "rp-go", disabled: true }, "組み直す");
      go.addEventListener("click", () => handlers.onReplan?.([...picked]));
      box.append(el("div", { class: "rp-actions" }, go));
    }

    if (rp.notes?.length) {
      box.append(el("p", { class: "fine" }, rp.notes.join(" ")));
    }
    box.append(el("p", { class: "fine" },
      "選んだものだけを条件に足して、これまでと同じ手順で組み直します。"
      + "押さないかぎり、旅程は変わりません。"));
    detail.push(box);
  }

  // 6. 旅程の調整。作り直しの入口を、旅程のすぐ上に置きます。
  // 条件の画面まで戻らせると、そこで手が止まります。
  if (handlers.onAdjust) {
    const chips = [
      { key: "slower", label: "もっとゆっくり",
        note: "立ち寄りを減らし、1か所あたりの時間を延ばします" },
      { key: "fuller", label: "もっと詰めこむ",
        note: "1日に回る数を増やします" },
      { key: "hidden", label: "もっと穴場に",
        note: "知る人ぞ知る場所の割合を上げます" },
      { key: "classic", label: "定番を中心に",
        note: "誰でも知っている場所を厚くします" },
    ];
    adjustBox = (el("section", { class: "panel adjust" },
      el("h3", {}, "この旅程を調整する"),
      el("div", { class: "adjust-row" },
        chips.map((c) => {
          const b = el("button", { type: "button", class: "adjust-chip",
                                   title: c.note }, c.label);
          b.addEventListener("click", () => handlers.onAdjust(c.key));
          return b;
        })),
      el("p", { class: "fine" },
        "押すと条件を書き換えて、旅程を組み直します。"
        + "経路の問い合わせは、採用した案にだけ行われます。")));
  }

  // 言葉で直す。AIは「条件の書き換え」に翻訳するだけで、
  // 旅程そのものは、これまでと同じエンジンが組み直します。
  if (handlers.onEdit) {
    const box = el("section", { class: "panel talk" });
    const input = el("input", {
      type: "text", id: "edit-text",
      placeholder: "例）もっとゆっくり／もう1泊増やして／松山城は外して",
      autocomplete: "off",
    });
    // 直前に言葉で直した内容があれば、組み直したあとも残します。
    // 何を言ってこうなったのかが分からないと、次の一手が打てません。
    const out = el("p", { class: "talk-out" }, itin.editNote ?? "");
    out.hidden = !itin.editNote;
    const send = el("button", { type: "button", class: "talk-go" }, "直す");
    const go = async () => {
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      out.hidden = false;
      out.className = "talk-out";
      out.textContent = "ご要望を読み取っています…";
      try {
        const said = await handlers.onEdit(text);
        out.textContent = said;
      } catch (e) {
        out.className = "talk-out ng";
        out.textContent = String(e?.message ?? e);
      } finally {
        send.disabled = false;
      }
    };
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });
    box.append(
      el("h3", {}, "言葉で直す"),
      el("div", { class: "talk-row" }, input, send),
      out,
      el("p", { class: "fine" },
        "書かれたことは「条件の書き換え」に翻訳されるだけで、"
        + "旅程はこれまでと同じ手順（営業時間と移動時間の照合）で"
        + "組み直します。AIに旅程を作らせることはしません。"));
    talkBox = box;
  }

  // --- 日ごと ---
  const sunById = new Map((itin.sun ?? []).map((n) => [n.itemId, n]));
  const daysWrap = el("div", { class: "days" });

  // 何日もある旅程は、日を選べるようにします。
  // 10日ぶんを縦に積むと、目当ての日にたどり着くまでが遠すぎます。
  if (itin.days.length > 1) {
    const tabs = el("div", { class: "day-tabs", role: "tablist",
                             "aria-label": "日を選ぶ" });
    itin.days.forEach((day, i) => {
      const btn = el("button", {
        type: "button", class: `day-tab${i === 0 ? " on" : ""}`,
        role: "tab", "aria-selected": i === 0 ? "true" : "false",
        "aria-controls": `day-${i}`, id: `daytab-${i}`,
      }, el("b", {}, `${i + 1}日目`), el("span", {}, fmtDay(day.date)));
      btn.addEventListener("click", () => selectDay(i));
      tabs.append(btn);
    });
    const all = el("button", { type: "button", class: "day-tab all" },
      el("b", {}, "全日"), el("span", {}, `${itin.days.length}日ぶん`));
    all.addEventListener("click", () => selectDay(-1));
    tabs.append(all);
    daysWrap.append(tabs);

    function selectDay(index) {
      for (const [i, sec] of [...daysWrap.querySelectorAll(".day")].entries()) {
        sec.hidden = index >= 0 && i !== index;
      }
      for (const [i, b] of [...tabs.querySelectorAll(".day-tab")].entries()) {
        const on = i === (index < 0 ? itin.days.length : index);
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      }
      handlers.onDay?.(index);
    }
  }

  itin.days.forEach((day, di) => {
    const section = el("section", {
      class: "day", id: `day-${di}`, role: "tabpanel",
      "aria-labelledby": itin.days.length > 1 ? `daytab-${di}` : null,
    });
    section.hidden = itin.days.length > 1 && di !== 0;
    section.append(el("h3", { class: "day-head" },
      el("b", {}, itin.days.length > 1 ? `${di + 1}日目` : "旅程"),
      el("span", {}, fmtDay(day.date)),
      el("i", {}, dayShape(day))));

    const list = el("ol", { class: "timeline" });
    day.items.forEach((item, ii) => {
      list.append(renderItem(item, ii, itin, handlers, sunById.get(item.id)));
    });
    section.append(list);
    daysWrap.append(section);
  });
  // --- ここから並べ直し ---------------------------------------------------
  //
  // 旅程を、いちばん上に置きます。
  //
  // 以前は 3案 が旅程より上にありました。けれど、旅程ができた直後に
  // 知りたいのは「で、何時にどこへ行くのか」です。案を選び直すのは、
  // それを見たあとの話です。順番が逆でした。
  //
  //   要約 → 流れ → 旅程 → 3案 → 言葉で直す → 調整 → 詳しく見る
  container.append(daysWrap);
  if (variantsBox) container.append(variantsBox);
  if (talkBox) container.append(talkBox);
  if (adjustBox) container.append(adjustBox);
  if (detail.length) {
    const more = el("details", { class: "more" });
    more.append(el("summary", {},
      el("span", {}, "この旅程をくわしく見る"),
      el("span", { class: "more-count" }, `${detail.length}件`)));
    more.append(...detail);
    container.append(more);
  }

  container.append(...[el("div", { class: "actions" },
    handlers.onSave
      ? el("button", { class: "ghost keep", onClick: (e) => {
          handlers.onSave();
          e.currentTarget.textContent = "保存しました";
          e.currentTarget.disabled = true;
        } }, "この旅を保存する")
      : null,
    el("button", { class: "ghost", onClick: handlers.onBack },
      "条件を変えてつくり直す"),
    el("button", { class: "ghost", onClick: () => window.print() },
      "印刷 / PDFで保存"),
    handlers.onShare
      ? el("button", { class: "ghost", onClick: handlers.onShare }, "この条件を共有")
      : null)].filter(Boolean));
}

/** その日の一行要約。開いていない日でも中身が想像できるように。 */
function dayShape(day) {
  const spots = day.items.filter((i) => i.kind === "spot");
  if (!spots.length) return "移動と休息の日";
  const first = day.items.find((i) => i.kind === "spot");
  const last = [...day.items].reverse().find((i) => i.kind === "spot");
  return `${spots.length}か所 · ${fmtTime(first.start)}〜${fmtTime(last.end)}`;
}

function levelClass(score) {
  if (score >= 78) return "high";
  if (score >= 58) return "mid";
  if (score >= 36) return "low";
  return "calm";
}

function tripMinutes(itin) {
  const all = itin.days.flatMap((d) => d.items);
  if (!all.length) return 0;
  return Math.round((all.at(-1).end - all[0].start) / 60000);
}

function stat(value, label) {
  return el("div", {}, el("strong", {}, value), el("span", {}, label));
}

/**
 * 旅行中モードの画面。
 *
 * 当日に知りたいのは「次に何をすればいいか」だけです。長い旅程を
 * 出しても、スクロールして自分の現在地を探しているあいだに電車が
 * 出ていきます。次の一手を大きく出し、遅れているときだけ
 * 「どこを削れば帰れるか」を添えます。
 */
export function renderToday(container, itin, trip, handlers = {}) {
  container.textContent = "";
  const now = handlers.now ?? new Date();
  const step = currentStep(itin, now);
  const box = el("section", { class: "today" });

  if (step.phase === "before") {
    box.append(el("p", { class: "today-when" }, "旅はまだ始まっていません"),
               el("p", { class: "today-next" },
                 `出発は ${fmtDay(itin.days[0].date)} です。`));
    container.append(box);
    return;
  }
  if (step.status === "done" || step.phase === "after") {
    box.append(el("p", { class: "today-when" }, "今日の予定はここまでです"),
               el("p", { class: "today-next" }, "おつかれさまでした。"));
    container.append(box);
    return;
  }

  const n = step.next;
  box.append(el("p", { class: "today-when" },
    `${step.day + 1}日目 ・ ${fmtTime(now)} 現在`));

  if (n) {
    box.append(el("p", { class: "today-label" },
      step.status === "during" ? "次の予定" : "つぎは"));
    box.append(el("p", { class: "today-next" }, n.title));
    // 移動なら「出発」、見学や食事なら「から」。
    // 見学に「出発」と書くと、そこを出る時刻に読めます。
    const when = n.kind === "transit" ? "出発" : "から";
    box.append(el("p", { class: "today-at" },
      `${fmtTime(n.start)} ${when}`
      + (step.minutesUntil > 0 ? ` ・ あと ${step.minutesUntil}分` : "")));
    if (n.detail) box.append(el("p", { class: "today-detail" }, n.detail));

    // 旅行中にいちばん要るのは「そこへどう行くか」です。
    //
    // 案内そのものを自前で作る必要はありません。地図アプリのほうが
    // ずっとよくできています。ここでやるべきは、**引き渡しを一手で
    // 済ませる**ことです。現在地は取りません。origin を空にすると、
    // 地図アプリ側が自分で現在地を使います。
    const target = n.place ?? n.to ?? n.spot;
    const nav = directionsFromHereUrl(target);
    if (nav) {
      box.append(el("a", {
        class: "today-nav md-state", href: nav,
        target: "_blank", rel: "noopener noreferrer",
      }, el("span", { "aria-hidden": "true" }, "➤"),
         el("span", {}, `現在地から「${target.name ?? n.title}」へ案内`)));
    }

    if (n.transit?.segments?.length) box.append(transitSteps(n.transit));

    // いま着いたことを押せるようにします。遅れはここから数えます。
    //
    // 押す対象は「行き先」です。移動そのものに「着いた」とは言いません
    // （「小町通りへ移動 に着いた」は日本語として通りません）。
    const arrivable = [step.current, n]
      .find((x) => x && ["spot", "meal", "lodging"].includes(x.kind));
    if (handlers.onArrived && arrivable) {
      const btn = el("button", { class: "md-btn md-btn--tonal md-state",
                                 type: "button" },
        el("span", {}, `「${arrivable.title}」に着いた`));
      btn.addEventListener("click", () => handlers.onArrived(arrivable.id));
      box.append(el("div", { class: "today-actions" }, btn));
    }
  }

  // 遅れ
  if (itin.catchUp?.lateMin > 0) {
    const c = itin.catchUp;
    const late = el("div", {
      class: `notice${c.enough ? "" : " notice--error"}`,
    });
    late.append(el("h3", {}, `${c.lateMin}分 遅れています`),
                el("p", {}, c.summary));
    if (c.actions.length && handlers.onCatchUp) {
      const row = el("div", { class: "today-actions" });
      const btn = el("button", { class: "md-btn md-btn--filled md-state",
                                 type: "button" },
        el("span", {}, "この形で組み直す"));
      btn.addEventListener("click", () => handlers.onCatchUp(c.actions));
      row.append(btn);
      late.append(row);
    }
    box.append(late);
  }

  container.append(box);
}

/** 軸ごとの点を、星と数字で並べます。 */
function axisList(axes) {
  return el("ul", { class: "axes" }, (axes ?? []).map((a) => el("li", {},
    el("span", { class: "ax-ic", "aria-hidden": "true" }, a.icon),
    el("span", { class: "ax-label" }, a.label),
    el("span", { class: "ax-stars", "aria-label": `${a.stars} / 5` },
      el("span", {}, "★".repeat(a.stars)),
      el("span", { class: "off" }, "★".repeat(5 - a.stars))),
    el("span", { class: "ax-score" }, String(a.score)),
    a.note ? el("span", { class: "ax-note" }, a.note) : null)));
}

/** 情報の出どころの印。色だけでなく、必ず言葉を添えます。 */
function srcChip(c, extra = "") {
  const title = [c.text, c.checkedAt ? `（${c.checkedAt} 時点）` : ""]
    .filter(Boolean).join("");
  return el("span", { class: `src src--${c.level}`, title },
    el("span", { "aria-hidden": "true" }, c.icon),
    el("span", {}, extra ? `${c.label}・${extra}` : c.label));
}

/** 乗換の手順を、開閉できる形で並べます。 */
function transitSteps(t) {
  const lines = describeTransit(t);
  const box = el("details", { class: "transit-steps" });
  const head = [
    t.boardAt && t.alightAt ? `${t.boardAt} → ${t.alightAt}` : "乗り換えの手順",
    t.headline,
  ].filter(Boolean).join("　");
  box.append(el("summary", {}, head));
  box.append(el("ol", { class: "ts-list" },
    t.segments.map((seg, i) => el("li", { class: `ts ${seg.kind}` },
      el("span", { class: "ts-ic", "aria-hidden": "true" },
        { walk: "🚶", wait: "⏳", ride: "🚃" }[seg.kind] ?? "・"),
      el("span", { class: "ts-tx" }, lines[i])))));
  return box;
}

/** 点の帯。色だけで意味を伝えないよう、必ず数字と言葉を添えます。 */
function scoreClass(n) {
  return n >= 75 ? "good" : n >= 55 ? "mid" : "bad";
}

/**
 * 旅程全体を、まず一言で言い切ります。
 *
 * 見るのは「無理がないか」だけです。適合度も混雑も点はありますが、
 * 最初に知りたいのは「この予定で本当に回れるのか」です。それが
 * 通ってから、好みに合うかを見ます。順番を逆にすると、
 * 帰れない旅程に「ご希望との相性 92点」と書くことになります。
 */
function summaryVerdict(itin) {
  const total = itin?.score?.total;
  if (!Number.isFinite(total)) return null;
  const slack = itin.slack;
  const back = slack && slack.level !== "unknown" && Number.isFinite(slack.minutes)
    ? `帰りの余裕 ${fmtDuration(slack.minutes)}`
    : "";
  const level = scoreClass(total);
  const label = level === "good" ? "無理なく回れます"
    : level === "mid" ? "少し急ぎめです"
      : "かなり詰まっています";
  const detail = [back, `無理のなさ ${total}/100`]
    .filter(Boolean).join("・");
  return { level, label, detail };
}

/** 疲労の段階。0〜30 ゆったり / 〜60 普通 / 〜80 やや疲れる / それ以上 過密。 */
function fatigueClass(n) {
  return n >= 80 ? "hard" : n >= 60 ? "warn" : n >= 30 ? "mid" : "easy";
}

/**
 * カードの絵。まず art.js の色の面を敷き、写真が取れたら上に重ねます。
 *
 * 写真を待ってからカードを出すのは間違いです。通信は失敗しますし、
 * 遅れます。先に絵で出しておき、届いたぶんだけ静かに差し替えます。
 */
function cardArt(spot, { tall = false } = {}) {
  const art = artFor(spot);
  const box = el("div", { class: tall ? "sheet-art" : "card-art",
                          style: `background-image:${art.css}` });
  if (spot?.fame_tier) {
    box.append(el("em", { class: `tier ${spot.fame_tier}` },
      TIER_LABEL[spot.fame_tier]));
  }
  box.append(el("span", { class: "art-ic", "aria-hidden": "true" }, art.icon));

  const img = el("img", { alt: "", loading: "lazy", decoding: "async",
                          class: tall ? "" : "card-photo" });
  photoFor(spot).then((url) => {
    if (!url) return;
    img.addEventListener("load", () => img.classList.add("on"), { once: true });
    img.src = url;
  }).catch(() => { /* 写真は飾りです。取れなくても絵のままで十分です */ });
  box.prepend(img);
  return box;
}

function renderItem(item, index, itin, handlers, sunNote) {
  const minutes = Math.round((item.end - item.start) / 60000);
  // 所要時間に比例した高さにします。数字を読まなくても、
  // どこが詰まっていてどこに余裕があるかが形で分かります。
  const height = Math.max(46, Math.min(150, 42 + minutes * 0.62));
  const li = el("li", {
    class: `tl ${item.kind}`,
    style: `--i:${Math.min(index, 14)};--h:${Math.round(height)}px`,
    "data-item": item.id,
    "data-spot": item.spotId ?? null,
  });

  li.append(
    el("div", { class: "time" },
      el("b", {}, fmtTime(item.start)),
      el("span", {}, fmtDuration(minutes))),
    el("div", { class: "rail" }, el("i", {})),
  );

  const body = el("div", { class: `body${item.kind === "spot" ? " tap" : ""}` });

  // スポットは「泡」のような大きなカードにします。上に絵（取れれば写真）、
  // 下に文字。一覧を流し見たとき、読む前にどんな場所かが入るように。
  const info = item.kind === "spot" ? el("div", { class: "card-info" }) : body;
  if (item.kind === "spot") body.append(cardArt(item.place), info);

  const title = el("div", { class: "title" },
    el("span", { class: "ic", "aria-hidden": "true" }, ICON[item.kind] ?? "•"),
    el("span", { class: "tx" }, item.title));
  // ティアの粒はカードの絵の上に置くので、ここでは重ねません
  if (item.place?.fame_tier && item.kind !== "spot") {
    title.append(el("em", { class: `tier ${item.place.fame_tier}` },
      TIER_LABEL[item.place.fame_tier]));
  }
  if (item.kind === "spot" && item.place && itin.crowd) {
    const c = crowdLevel(item.place, item.start);
    title.append(el("em", {
      class: `crowd-chip lv-${levelClass(c.score)}`,
      title: c.reasons.join("・") || "混雑の見込み",
    }, c.label));
  }
  info.append(title);

  if (item.detail) {
    const line = el("p", { class: "detail" }, el("span", {}, item.detail));
    // 実際に経路検索で取れた時間なのか、距離からの推定なのか。
    // 同じ「約42分」でも、意味がまったく違います。
    if (item.kind === "transit") {
      line.append(" ", srcChip(confidenceOf("travel", item)));
    }
    info.append(line);
  }

  // 公共交通の中身。所要時間だけでは、現地で予定どおりかを確かめられません。
  // 折りたたんで置き、必要なときだけ開けるようにします。
  if (item.transit?.segments?.length) {
    info.append(transitSteps(item.transit));
  }
  if (item.kind === "spot" && (item.reason || item.fit)) {
    info.append(el("p", { class: "reason" }, item.fit?.summary ?? item.reason));
    // なぜここが選ばれたのか。軸ごとに出すと、納得も反論もできます。
    if (item.fit?.axes?.length) {
      const box = el("details", { class: "transit-steps" });
      box.append(el("summary", {}, `この場所を選んだ理由（適合 ${item.fit.total}）`));
      const inner = el("div", { style: "padding:8px 14px 14px" },
        axisList(item.fit.axes));
      // その場所がどういう場所か。知名度だけでは分かりません。
      inner.append(el("p", { class: "fine", style: "margin-top:12px" },
        "この場所の性格"));
      inner.append(el("ul", { class: "quality" },
        qualityOf(item.place).map((q) => el("li", {},
          el("span", { class: "q-ic", "aria-hidden": "true" }, q.icon),
          el("span", { class: "q-label" }, q.label),
          el("span", { class: "q-stars", "aria-label": `${q.stars} / 5` },
            el("span", {}, "★".repeat(q.stars)),
            el("span", { class: "off" }, "★".repeat(5 - q.stars)))))));
      box.append(inner);
      info.append(box);
    }
  }
  if (sunNote) {
    info.append(el("p", { class: `sun ${sunNote.kind}` },
      el("span", { "aria-hidden": "true" },
        sunNote.kind === "dark" ? "🌙" : "🌇"),
      " ", sunNote.text));
  }
  // その日の営業時間。閉館だけでなく最終入場も出します。
  // 「17:00まで開いている」と「16:30までに入れば見られる」は別のことです。
  if (item.hoursText) {
    const p = el("p", { class: "hours" },
      el("span", { "aria-hidden": "true" }, "🕘"),
      el("span", {}, item.hoursText));
    if (item.place) p.append(srcChip(confidenceOf("hours", item.place)));
    if (item.hoursNote) p.title = item.hoursNote;
    info.append(p);
  }

  // 事前予約。行ってから知るのがいちばん困ります。
  if (item.kind === "spot" && item.place) {
    const r = reservationOf(item.place);
    if (r.required || r.likely) {
      const p = el("p", { class: `reserve${r.required ? " need" : ""}` },
        el("span", { "aria-hidden": "true" }, r.required ? "⚠" : "ℹ"),
        el("span", {}, r.text));
      if (r.url) {
        p.append(el("a", { href: r.url, target: "_blank", rel: "noreferrer",
                           class: "link" }, "予約ページ"));
      }
      info.append(p);
    }
  }

  if (item.costYen > 0) {
    info.append(el("p", { class: "cost" },
      `¥${item.costYen.toLocaleString()}${item.estimated === false ? "" : "（目安）"}`));
  }

  // 食事・宿泊・スポットの外部リンク
  const ctx = {
    lat: item.near?.lat ?? item.place?.lat,
    lng: item.near?.lng ?? item.place?.lng,
    regionName: item.near?.regionName ?? itin.regionName,
    place: item.place, wikipedia: item.place?.wikipedia,
    checkIn: item.checkIn, checkOut: item.checkOut,
    from: item.from, to: item.to,
  };
  const links = linksForItem(item, ctx);
  if (links.length) {
    info.append(el("div", { class: "item-links" },
      links.map((l) => el("a", {
        href: l.url, target: "_blank", rel: "noreferrer",
        class: l.primary ? "link primary-link" : "link",
      }, l.label))));
  }

  if (item.kind === "spot" && handlers.onSpot) {
    // クリックだけでなくキーボードでも開けるようにします
    body.setAttribute("role", "button");
    body.setAttribute("tabindex", "0");
    const open = (e) => {
      if (e.target.closest("a")) return;
      handlers.onSpot(item);
    };
    body.addEventListener("click", open);
    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); }
    });
    if (handlers.onHover) {
      li.addEventListener("mouseenter", () => handlers.onHover(item, true));
      li.addEventListener("mouseleave", () => handlers.onHover(item, false));
      body.addEventListener("focus", () => handlers.onHover(item, true));
      body.addEventListener("blur", () => handlers.onHover(item, false));
    }
    body.append(el("span", { class: "chev", "aria-hidden": "true" }, "›"));
  }

  li.append(body);
  return li;
}

export function openSheet(item, { onClose, describe }) {
  const spot = item.place;
  const prof = profileOf(spot);
  const bg = el("div", { class: "md-sheet-scrim" });
  const sheet = el("div", { class: "md-sheet", role: "dialog",
                            "aria-modal": "true", "aria-label": spot.name });

  const at = item.start ?? new Date();
  const day = hoursFor(spot, at);
  const hours = describeHours(spot, at);

  sheet.append(el("div", { class: "md-sheet-handle" }, el("i", {})));
  sheet.append(el("button", {
    class: "md-icon-btn md-state close", type: "button",
    "aria-label": "閉じる", onClick: () => close(),
  }, el("span", { "aria-hidden": "true" }, "✕")));

  // 写真ヘッダー。スクロールに合わせて遅れて動きます。
  const art = cardArt(spot, { tall: true });
  sheet.append(art);
  sheet.addEventListener("scroll", () => {
    art.style.backgroundPositionY = `${sheet.scrollTop * 0.35}px`;
  }, { passive: true });

  const body = el("div", { class: "sheet-body" });
  body.append(
    el("h3", {}, spot.name),
    el("p", { class: "sub" },
      [spot.category, spot.prefecture, spot.region].filter(Boolean).join("・")),
  );

  const desc = el("p", { class: "desc" }, spot.description ?? "");
  body.append(desc);

  // なぜこの場所が選ばれたのか。地の文と混ぜず、引用として見せます。
  if (item.fit?.summary || item.reason) {
    body.append(el("p", { class: "why-quote" },
      item.fit?.summary ?? item.reason));
  }
  if (item.fit?.axes?.length) {
    body.append(el("div", { class: "card", style: "padding:16px" },
      axisList(item.fit.axes)));
  }

  body.append(el("div", { class: "card" },
    row("目安の滞在時間", fmtDuration(prof.dwell)),
    row(day.closed ? "この日は" : "見学できる時間", hours),
    row("入場料", prof.fee === 0 ? "無料" : `¥${prof.fee.toLocaleString()}`)));

  // 情報の出どころ。営業時間と料金で違うことがあるので、分けて出します。
  body.append(el("div", { class: "links", style: "margin-top:12px" },
    srcChip(confidenceOf("hours", spot), "営業時間"),
    srcChip(confidenceOf("fee", spot), "料金")));

  const reserve = reservationOf(spot);
  if (reserve.required || reserve.likely) {
    const p = el("p", {
      class: reserve.required ? "hint warn-hint" : "hint",
    }, reserve.text);
    if (reserve.url) {
      p.append(" ", el("a", { href: reserve.url, target: "_blank",
                              rel: "noreferrer" }, "予約ページ"));
    }
    body.append(p);
  }

  body.append(el("ul", { class: "quality", style: "margin-top:16px" },
    qualityOf(spot).map((q) => el("li", {},
      el("span", { class: "q-ic", "aria-hidden": "true" }, q.icon),
      el("span", { class: "q-label" }, q.label),
      el("span", { class: "q-stars", "aria-label": `${q.stars} / 5` },
        el("span", {}, "★".repeat(q.stars)),
        el("span", { class: "off" }, "★".repeat(5 - q.stars)))))));

  if (day.riskyNote) {
    body.append(el("p", { class: "hint warn-hint" }, day.riskyNote));
  }
  if (day.note) body.append(el("p", { class: "hint" }, day.note));

  const links = linksForItem({ kind: "spot" },
    { place: spot, wikipedia: spot.wikipedia });
  body.append(el("div", { class: "links" },
    links.map((l) => el("a", {
      href: l.url, target: "_blank", rel: "noreferrer",
      class: l.primary ? "primary" : "",
    }, l.label))));

  sheet.append(body);
  bg.append(sheet);
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  document.body.append(bg);

  // aria-modal="true" は、支援技術に「これは前面のものです」と伝えるだけで、
  // Tab の行き先までは変えません。実装しないと、Tab を押しつづけたときに
  // 後ろの旅程やフォームへ抜けていきます。見えているのはシートだけなので、
  // 使う側からは、フォーカスが行方不明になったように見えます。
  const opener = document.activeElement;
  const focusables = () => [...sheet.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]),'
    + ' textarea:not([disabled]), select:not([disabled]),'
    + ' details > summary, [tabindex]:not([tabindex="-1"])')]
    .filter((e) => e.offsetParent !== null);

  // 開いたら、シートの中へ入れます。入れないと、閉じるボタンへ
  // たどり着くまでに、後ろの要素を全部通ることになります。
  (focusables()[0] ?? sheet).focus?.();

  const onKey = (e) => {
    if (e.key === "Escape") { close(); return; }
    if (e.key !== "Tab") return;
    const list = focusables();
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last = list.at(-1);
    // 端まで来たら、反対の端へ回します（外へは出しません）。
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    } else if (!sheet.contains(document.activeElement)) {
      e.preventDefault(); first.focus();
    }
  };
  document.addEventListener("keydown", onKey);

  describe?.(spot).then((text) => {
    if (text && text !== spot.description) desc.textContent = text;
  }).catch(() => { /* 説明が取れなくても表示は保つ */ });

  function close() {
    document.removeEventListener("keydown", onKey);
    bg.remove();
    // 閉じたら、開いたところへ戻します。戻さないと、フォーカスが
    // <body> に落ち、次の Tab がページの先頭から始まります。
    // どこを読んでいたのかが分からなくなります。
    if (opener instanceof HTMLElement && document.contains(opener)) {
      opener.focus();
    }
    onClose?.();
  }
  return close;
}

function row(label, value) {
  return el("div", { class: "row" },
    el("span", {}, label), el("b", {}, value));
}

/** 見学（スポット滞在）に使った時間の合計。 */
function sightseeingMinutes(itin) {
  let m = 0;
  for (const day of itin.days) {
    for (const item of day.items) {
      if (item.kind === "spot") m += (item.end - item.start) / 60000;
    }
  }
  return Math.round(m);
}

/** 「こうすれば行けます」のボタン。押すと条件を書き換えて組み直します。 */
export function suggestionButton(s, onSuggest) {
  return el("button", {
    class: "relax-btn md-state", type: "button",
    onClick: () => onSuggest(s),
  }, el("b", {}, s.label), el("span", {}, s.detail));
}
