// OpenStreetMap の地図（Leaflet）。
//
// 旅程を地図で見せるのは飾りではありません。「その順に回って本当に無理が
// ないか」は、線で結ばれた形を見た瞬間に分かります。数字の羅列では
// 気づけない遠回りが目で分かるので、時刻表と対にして置いています。
//
// Leaflet は CDN から読み込み、window.L として使います。

const DEFAULT_CENTER = [35.681236, 139.767125];

export class TripMap {
  constructor(elementId) {
    this.el = document.getElementById(elementId);
    this.map = null;
    this.layer = null;
    this.markers = [];
    this.bySpot = new Map();   // spotId → マーカー（旅程との連動用）
    this.points = [];
  }

  get available() {
    return Boolean(this.el && window.L);
  }

  ensure() {
    if (!this.available) return false;
    if (this.map) return true;
    const L = window.L;
    this.map = L.map(this.el, {
      scrollWheelZoom: false,   // ページのスクロールを奪わない
      zoomControl: true,
    }).setView(DEFAULT_CENTER, 9);
    L.tileLayer(this.tileUrl, {
      attribution: this.attribution,
      maxZoom: 19,
    }).addTo(this.map);
    this.layer = L.layerGroup().addTo(this.map);
    return true;
  }

  configure({ tileUrl, attribution }) {
    this.tileUrl = tileUrl;
    this.attribution = attribution;
  }

  clear() {
    this.layer?.clearLayers();
    this.markers = [];
    this.bySpot.clear();
  }

  /**
   * 旅程を描きます。
   * @param {Array<{lat,lng,label,kind,order}>} points 訪問順
   */
  render(points) {
    if (!points.length) return;
    if (!window.L) {
      // 地図ライブラリを読み込めない環境（オフラインや CDN 遮断）では、
      // 灰色の四角を黙って出すのではなく理由を書きます。旅程自体は
      // 地図なしでも成立します。
      this.el.classList.add("map-fallback");
      this.el.textContent =
        "地図を読み込めませんでした（インターネット接続を確認してください）。"
        + "旅程はこのままご利用いただけます。";
      return;
    }
    this.el.classList.remove("map-fallback");
    this.points = points;
    if (!this.ensure()) return;
    const L = window.L;
    this.clear();

    const latlngs = [];
    points.forEach((p, i) => {
      const latlng = [p.lat, p.lng];
      latlngs.push(latlng);

      const marker = L.marker(latlng, { icon: this.icon(p, i) })
        .addTo(this.layer);
      marker.bindPopup(
        `<strong>${escapeHtml(p.label)}</strong>`
        + (p.time ? `<br><span>${escapeHtml(p.time)}</span>` : ""));
      // 重なったときに、番号の若いほうを手前に出します。
      // Leaflet は既定で「南にあるものほど手前」なので、1 が 2 の
      // 後ろに隠れることがありました。どこから始まるかが読めません。
      marker.setZIndexOffset?.(1000 - i * 10);
      if (p.onClick) marker.on("click", p.onClick);
      if (p.spotId) this.bySpot.set(p.spotId, marker);
      this.markers.push(marker);
    });

    // 線は引きません。
    //
    // 太い線で結んでいたときは、それが**実際に通る道に見えました**。
    // こちらが持っているのは点の座標だけで、線は2点を直線でつないだ
    // ものです。海の上や山の中をまっすぐ横切ります。
    // 「その道を行く」と読まれてしまうものを、根拠なく描くべきでは
    // ありません。順番は、ピンの番号で足ります。
    //
    // 実際の道が要るときは、旅程から「経路を開く」で地図アプリへ
    // 渡します（そちらは本物の経路を持っています）。

    const bounds = L.latLngBounds(latlngs);
    this.map.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 });
  }

  icon(point, index) {
    const L = window.L;
    const isEndpoint = point.kind === "origin" || point.kind === "end";
    // 出発と終点は緑（systemGreen）、立ち寄りは青（systemBlue）。
    // 番号を中に入れます。
    const bg = isEndpoint ? "#34C759" : "#007AFF";
    const label = isEndpoint ? "" : String(index);

    // HTML の文字列ではなく、要素そのものを渡します。
    // Leaflet は 1.4 から HTMLElement を受け取ります。文字列で組むと、
    // そこが innerHTML になります。いまは安全な値しか入りませんが、
    // 「いまは」で持たせる作りにしないためです。
    const pin = document.createElement("span");
    pin.style.background = bg;
    const num = document.createElement("b");
    num.textContent = label;
    pin.append(num);

    return L.divIcon({
      // 出発・終点は形も変えます。色だけで分けると、色の見分けが
      // つきにくい人には同じものに見えます。
      className: `trip-pin${isEndpoint ? " endpoint" : ""}`,
      html: pin,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
      popupAnchor: [0, -28],
    });
  }

  /** 指定の地点へ寄る（旅程からタップされたとき）。 */
  focus(lat, lng, zoom = 15) {
    if (!this.ensure()) return;
    this.map.setView([lat, lng], zoom, { animate: true });
  }

  invalidate() {
    this.map?.invalidateSize();
  }
}


function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** 旅程から、地図に落とす点の並びを作ります。 */
export function pointsFromItinerary(itin, trip) {
  const points = [];
  if (trip?.origin) {
    points.push({ lat: trip.origin.lat, lng: trip.origin.lng,
                  label: trip.origin.name, kind: "origin" });
  }
  let n = 0;
  for (const [di, day] of itin.days.entries()) {
    for (const item of day.items) {
      if (item.kind !== "spot" || !item.place) continue;
      n++;
      points.push({
        lat: item.place.lat, lng: item.place.lng,
        label: item.title, kind: "spot", order: n,
        time: fmtTime(item.start),
        spotId: item.spotId, day: di,
      });
    }
  }
  const last = itin.days.at(-1)?.items.at(-1);
  if (last?.to) {
    points.push({ lat: last.to.lat, lng: last.to.lng,
                  label: last.to.name ?? "終点", kind: "end" });
  }
  return points;
}

function fmtTime(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 旅程の行と地図のピンをつなぐ。
 *
 * 数字が並んでいるだけでは、その場所が地図のどこなのか分かりません。
 * 旅程に触れたらピンが目立ち、逆も同じ、という往復ができると、
 * 「この順で無理がないか」がひと目で確かめられます。
 */
TripMap.prototype.highlight = function highlight(spotId, on) {
  const marker = spotId && this.bySpot.get(spotId);
  if (!marker) return;
  const node = marker.getElement?.();
  if (node) node.classList.toggle("hl", Boolean(on));
  if (on) marker.openPopup?.();
};

/** その日の地点だけを表示する（-1 で全日）。 */
TripMap.prototype.showDay = function showDay(dayIndex) {
  if (!this.points.length) return;
  const pts = dayIndex < 0
    ? this.points
    : this.points.filter((p) => p.day === undefined || p.day === dayIndex
        || p.kind !== "spot");
  const target = pts.length ? pts : this.points;
  if (!window.L || !this.map) return;
  const bounds = window.L.latLngBounds(target.map((p) => [p.lat, p.lng]));
  this.map.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 });
};
