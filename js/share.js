// 旅程を、そのまま貼れる文字にする。
//
// 旅程はこのアプリの画面で読むのがいちばんですが、同行者に送るのは
// LINE やメールです。リンクを送っても、相手の端末で組み直すと時刻が
// 変わることがあります。**いま画面に出ているとおり**の旅程を、
// 文字で渡せるようにします。写真も地図も要りません。何時にどこか、
// だけで当日はまわれます。

// 印は**言葉**にします。以前は絵文字（🚃 📍 🍽）でした。貼る先は
// LINE・メール・メモ帳で、相手の端末に無い絵文字は豆腐（□）になります。
// 「□ 出雲大社」では何の行か分かりません。js/icons.js の TEXT_MARK は
// 画面の記号と対になる短い当て字です（[移動] [立寄] …）。
import { TEXT_MARK } from "./icons.js";

function pad(n) { return String(n).padStart(2, "0"); }

function time(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "--:--";
  return `${t.getHours()}:${pad(t.getMinutes())}`;
}

function day(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  const w = "日月火水木金土"[t.getDay()];
  return `${t.getMonth() + 1}月${t.getDate()}日(${w})`;
}

/**
 * 旅程を1つの文字列にします。
 *
 * @param {{title?:string, subtitle?:string, days?:Array}} itin
 * @param {{url?:string}} [opts] 末尾に添えるリンク（あれば）
 * @returns {string}
 */
export function itineraryText(itin, opts = {}) {
  const lines = [];
  const head = [itin?.title, itin?.subtitle].filter(Boolean).join(" · ");
  if (head) lines.push(head);
  const days = Array.isArray(itin?.days) ? itin.days : [];
  days.forEach((d, i) => {
    if (lines.length) lines.push("");
    const label = days.length > 1 ? `${i + 1}日目` : "";
    lines.push(`■ ${[label, day(d.date)].filter(Boolean).join(" ")}`.trimEnd());
    for (const item of d.items ?? []) {
      // 空き時間は、書いても相手にすることがありません。
      if (item.kind === "free") continue;
      const ic = TEXT_MARK[item.kind] ?? "・";
      const title = String(item.title ?? "").trim();
      const minutes = item.start && item.end
        ? Math.round((new Date(item.end) - new Date(item.start)) / 60000) : 0;
      const what = item.kind === "meal"
        ? (item.food?.spotName ?? item.food?.dish) : null;
      const tail = what ? `（${what}）`
        : item.kind === "spot" && minutes > 0 ? `（${minutes}分）` : "";
      lines.push(`${time(item.start)} ${ic} ${title}${tail}`);
      if (item.kind === "transit" && item.detail) lines.push(`      ${item.detail}`);
      // 駄目だったときの代わり。送った先で読むものなので、ここにも入れます。
      if (item.backup?.text) lines.push(`      ↳ ${item.backup.text}`);
    }
  });
  if (opts.url) {
    lines.push("", opts.url);
  }
  lines.push("", "旅さき でつくった旅程です。営業時間や便は、出発前にもう一度確かめてください。");
  return lines.join("\n");
}
