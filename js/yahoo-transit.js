import { endpointFor } from "./endpoints.js";
import { effectiveConfig } from "./settings.js";

const TRANSIT_HORIZON_DAYS = 45;

/**
 * Yahoo!路線情報の検索をバックエンド経由で実行します。
 *
 * Tabisakiの旅程で実際に使うのは「この時刻に出発地を出たら、
 * 次に乗れる公共交通で何時に到着するか」です。そのため、Yahoo!には
 * 旅程側から渡された出発時刻をそのまま渡し、先の日付だけ同じ曜日・
 * 同じ時刻の直近の日へ寄せます。
 */
export async function searchYahooTransit(from, to, opts = {}) {
  const cfg = effectiveConfig();
  const fromName = String(from?.name ?? from ?? "").trim();
  const toName = String(to?.name ?? to ?? "").trim();
  if (!fromName || !toName) return null;

  const requested = opts.departAt ? new Date(opts.departAt) : neutralDepartureTime();
  const departAt = Number.isNaN(requested.getTime())
    ? neutralDepartureTime()
    : transitSearchDate(requested);

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
  // **いつのダイヤで調べたか**を返します。過ぎた日や、時刻表がまだ出て
  // いない先の日は、そのままでは調べられないので別の日時に寄せています。
  // それを黙っていると、旅程の時刻と、画面に出る「14:50発→18:40着」が
  // 食い違います（実際にそう出ていました）。
  return {
    ...doc,
    searchedAt: departAt.toISOString(),
    shifted: departAt.getTime() !== requested.getTime(),
  };
}

function neutralDepartureTime(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}

function transitSearchDate(date, now = new Date()) {
  const ahead = (date - now) / 86400000;
  if (ahead >= 0 && ahead <= TRANSIT_HORIZON_DAYS) return new Date(date);

  if (ahead < 0) return new Date(now.getTime() + 60000);

  const target = new Date(now);
  target.setDate(target.getDate() + 7);
  const diff = (date.getDay() - target.getDay() + 7) % 7;
  target.setDate(target.getDate() + diff);
  target.setHours(date.getHours(), date.getMinutes(), 0, 0);
  return target;
}
