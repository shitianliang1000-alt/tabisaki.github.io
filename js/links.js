// 外部サービスへのリンク。
//
// 食事と宿泊は、このアプリが在庫や価格を持たない領域です。名前を推測して
// 表示するより、その場所・その時間帯で実際に開いている店を Google マップ側で
// 見てもらうほうが確実なので、該当ページを直接開きます。
//
// いずれも公開されている URL 形式で、API キーは不要です。

/** 座標を Google マップで開く（スポットの詳細から）。 */
export function mapsPlaceUrl(place) {
  const q = encodeURIComponent(`${place.lat},${place.lng}`);
  const label = place.name ? `&query_place_id=` : "";
  void label;
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/** 名前で検索して開く（座標より名前のほうが当たりが良い施設向け）。 */
export function mapsSearchUrl(query, near) {
  const q = encodeURIComponent(query);
  if (near) {
    // /@lat,lng,zoom を付けるとその周辺が中心になる
    return `https://www.google.com/maps/search/${q}/@${near.lat},${near.lng},15z`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/**
 * 食事どころを探す。周辺の飲食店一覧を地図で開きます。
 * 昼食・夕食の項目から呼びます。
 */
export function restaurantsUrl(near, kind = "レストラン") {
  const where = near?.regionName ? `${near.regionName} ${kind}` : kind;
  return mapsSearchUrl(where, near);
}

/**
 * 宿を探す。Google のホテル検索（トラベル）を、日付付きで開きます。
 * 日付が入るぶん、素の地図検索より実用的です。
 */
export function hotelsUrl(near, checkIn, checkOut) {
  const parts = [];
  if (near?.regionName) parts.push(near.regionName);
  parts.push("ホテル");
  const q = encodeURIComponent(parts.join(" "));

  const url = new URL("https://www.google.com/travel/search");
  url.searchParams.set("q", decodeURIComponent(q));
  if (checkIn && checkOut) {
    // Google Travel は ISO の日付を受け取ります
    url.searchParams.set("checkin", isoDate(checkIn));
    url.searchParams.set("checkout", isoDate(checkOut));
  }
  return url.toString();
}

/** 経路を Google マップで開く（実際に移動するときに使う想定）。 */
export function directionsUrl(from, to, mode = "transit") {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", `${from.lat},${from.lng}`);
  url.searchParams.set("destination", `${to.lat},${to.lng}`);
  url.searchParams.set("travelmode", mode);
  return url.toString();
}

/**
 * いまいる場所から、その場所への経路。
 *
 * `origin` を空にすると、Google マップ側が現在地を使います。
 * 旅行中はそれが正しい起点です。旅程に書かれた「前の場所」から
 * 案内しても、すでに動いてしまった人には合いません。
 *
 * 位置情報をこちらで取る必要はありません。地図アプリに渡すだけです。
 */
export function directionsFromHereUrl(to, mode = "transit") {
  if (!Number.isFinite(to?.lat) || !Number.isFinite(to?.lng)) return "";
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", "");
  url.searchParams.set("destination", `${to.lat},${to.lng}`);
  url.searchParams.set("travelmode", mode);
  return url.toString();
}

/** 日本語 Wikipedia の記事。 */
export function wikipediaUrl(title) {
  const enc = encodeURIComponent(String(title ?? "").replace(/ /g, "_"));
  return `https://ja.wikipedia.org/wiki/${enc}`;
}

/** OpenStreetMap 上で見る。 */
export function osmUrl(place, zoom = 17) {
  return `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}`
    + `#map=${zoom}/${place.lat}/${place.lng}`;
}

function isoDate(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/**
 * 旅程の1項目に対して、開くべき外部リンクを返します。
 * UI はこの結果をそのままボタンにします。
 */
export function linksForItem(item, ctx = {}) {
  const out = [];
  const near = { lat: ctx.lat, lng: ctx.lng, regionName: ctx.regionName };

  switch (item.kind) {
    case "meal": {
      const kind = item.title.includes("夕") ? "ディナー" : "ランチ";
      out.push({
        label: `${kind}のお店を地図で探す`,
        url: restaurantsUrl(near, "レストラン"),
        primary: true,
      });
      break;
    }
    case "lodging": {
      out.push({
        label: "この日の宿を探す",
        url: hotelsUrl(near, ctx.checkIn, ctx.checkOut),
        primary: true,
      });
      break;
    }
    case "spot": {
      if (ctx.place) {
        out.push({ label: "地図で開く", url: mapsPlaceUrl(ctx.place), primary: true });
        if (ctx.wikipedia) {
          out.push({ label: "Wikipedia", url: wikipediaUrl(ctx.wikipedia) });
        }
        out.push({ label: "OpenStreetMap", url: osmUrl(ctx.place) });
      }
      break;
    }
    case "transit": {
      if (ctx.from && ctx.to) {
        out.push({ label: "経路を開く", url: directionsUrl(ctx.from, ctx.to) });
      }
      break;
    }
    default:
      break;
  }
  return out;
}
