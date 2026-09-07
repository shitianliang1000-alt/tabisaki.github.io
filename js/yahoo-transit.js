import { endpointFor } from "./endpoints.js";
import { effectiveConfig } from "./settings.js";

/**
 * Yahoo!路線情報の検索をバックエンド経由で実行します。
 *
 * from / to は駅名を渡す想定です。座標しかない地点は呼び出し側で
 * nearestStop() を使って駅・バス停へ解決してから渡します。
 */
export async function searchYahooTransit(from, to, opts = {}) {
  const cfg = effectiveConfig();
  const fromName = String(from?.name ?? from ?? "").trim();
  const toName = String(to?.name ?? to ?? "").trim();
  if (!fromName || !toName) return null;

  const res = await fetch(endpointFor("yahoo:transit", {}, cfg), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromName,
      to: toName,
      departAt: opts.departAt?.toISOString?.() ?? null,
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Yahoo Transit ${res.status}`);
  return res.json();
}
