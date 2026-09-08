import { endpointFor } from "./endpoints.js";
import { effectiveConfig } from "./settings.js";

/**
 * Yahoo!路線情報の検索をバックエンド経由で実行します。
 *
 * 旅程で使うのは「この日、この時刻に出発地を出たら、次に乗れる
 * 公共交通で何時に到着するか」です。日時はそのまま渡します。
 */
export async function searchYahooTransit(from, to, opts = {}) {
  const cfg = effectiveConfig();
  const fromName = String(from?.name ?? from ?? "").trim();
  const toName = String(to?.name ?? to ?? "").trim();
  if (!fromName || !toName) return null;

  // **頼まれた日時で調べます。**
  //
  // 以前は、過ぎた日なら「いま」、先すぎる日なら「同じ曜日の来週」に
  // 寄せていました。返ってくるのは別の日の便なので、旅程の時刻と
  // 食い違います（9月6日4:00発の旅程に「14:50発→18:40着」）。
  // Yahoo!は過ぎた日でもその日のダイヤで答えるので、寄せる必要は
  // ありませんでした。答えられない日はYahoo!がそう言います。
  const requested = opts.departAt ? new Date(opts.departAt) : neutralDepartureTime();
  const departAt = Number.isNaN(requested.getTime())
    ? neutralDepartureTime() : requested;

  const res = await fetch(endpointFor("yahoo:transit", {}, cfg), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromName,
      to: toName,
      departAt: departAt.toISOString(),
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Yahoo Transit ${res.status}`);
  const doc = await res.json();
  return { ...doc, searchedAt: departAt.toISOString() };
}

function neutralDepartureTime(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}
