# -*- coding: utf-8 -*-
"""外部データから、公開用の知識ベースを組み立てる。

取り込む元
  1. 国土数値情報 観光資源（P12, 国土交通省）  … 全国 18,025 件
  2. これまでの収録データ（手作業で確認済み）   … 232 件

観光資源台帳（日本観光振興協会）の KML も取り込んでいましたが、
**再配布してよいかがはっきりしない**ため外しました。収録は公開
リポジトリに入るので、条件の曖昧なものは置きません
（外した手順は tools/drop_daicho.py）。読み込みの関数（read_kml）は
残していますが、build からは呼びません。

このアプリは「エリア（拠点）→ その日に回るスポット」という組み立て方を
するので、点の集まりをそのまま入れても旅程になりません。市区町村でまとめ、
広すぎるところは距離で割って、エリアにしてから出力します。

出力は index.json + regions.json + spots-NN.json の分割形式です。
2万件を1つの JS モジュールに入れると数MBになり、読み込みが重くなるため
（この分割読み込みは kb.js に元からある仕組みです）。

  python3 tools/build_kb.py <P12を展開したディレクトリ> [出力先]
"""
import io, json, math, os, re, sys, unicodedata
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]

# 元データの資源タイプ → このアプリの分類（滞在時間・営業時間の既定値を引くため）
KIND_TO_CATEGORY = {
    "神社・寺院・教会": "寺院", "城跡・城郭・宮殿": "城", "史跡": "史跡",
    "建造物": "建築", "郷土景観": "町並み", "集落・街": "町並み",
    "庭園・公園": "庭園", "博物館・美術館": "博物館",
    "動植物園・水族館": "水族館", "テーマ・公園テーマ施設": "テーマパーク",
    "温泉": "温泉", "山岳": "山", "高原・湿原・原野": "高原",
    "河川・峡谷": "渓谷", "湖沼": "湖", "滝": "滝", "海岸・岬": "海岸",
    "岩石・洞窟": "史跡", "動物": "自然", "植物": "自然",
    "自然現象": "自然", "食": "グルメ",
    "年中行事": "年中行事", "年中行事(祭り・伝統行事)": "年中行事",
    "芸能・興行・イベント": "年中行事",
    "橋": "建築", "都市景観": "町並み", "峠": "展望台",
}

CATEGORY_GENRES = {
    "温泉": ["onsen"], "寺院": ["history"], "神社": ["history"],
    "城": ["history"], "史跡": ["history"], "町並み": ["history"],
    "庭園": ["nature"], "公園": ["nature"], "自然": ["nature"],
    "渓谷": ["nature"], "滝": ["nature"], "山": ["nature"], "高原": ["nature"],
    "湖": ["sea"], "海岸": ["sea"], "水族館": ["sea"],
    "博物館": ["art"], "美術館": ["art"], "建築": ["art"],
    "商店街": ["food"], "市場": ["food"], "グルメ": ["food"],
    "展望台": ["view"], "灯台": ["view"],
    "テーマパーク": ["city"], "観光名所": ["city"], "年中行事": ["city"],
}

# 分類ごとの既定値（feasibility.js の CATEGORY_PROFILES と揃える）
KNOWN_CATEGORIES = set(CATEGORY_GENRES) | {
    "国立公園", "登山", "丘", "川", "乗り物", "漁港", "牧場", "酒蔵",
    "文化施設", "商業施設", "教会", "動物園", "ロープウェイ", "飲食店",
}

# 名前から知名度を推し量る手がかり
MAJOR_WORDS = ("世界遺産", "国宝", "大社", "本宮", "総本山", "天守")
KNOWN_WORDS = ("城", "神宮", "大仏", "渓谷", "温泉", "美術館", "博物館")


def norm(s):
    return unicodedata.normalize("NFKC", (s or "").strip())


def in_japan(rec):
    """日本の範囲。ここを外れた座標は、名前が何であれ採用しません。"""
    return (20.0 <= rec["lat"] <= 46.0) and (122.0 <= rec["lng"] <= 154.0)


def haversine(a, b):
    R = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


# --- 読み込み ---------------------------------------------------------------

def read_p12(root):
    """国土数値情報 観光資源（点）。"""
    out = []
    files = sorted(f for f in os.listdir(root)
                   if re.match(r"^P12-\d+_\d+\.xml$", f))
    for fn in files:
        text = io.open(os.path.join(root, fn), encoding="utf-8").read()
        points = {}
        for m in re.finditer(
                r'<gml:Point gml:id="([^"]+)">\s*<gml:pos>([-\d.]+)\s+([-\d.]+)</gml:pos>',
                text):
            points[m.group(1)] = (float(m.group(2)), float(m.group(3)))
        for m in re.finditer(
                r"<ksj:TourismResource_Point.*?</ksj:TourismResource_Point>",
                text, re.S):
            block = m.group(0)
            name = pick(block, "turismResorceName")
            ref = re.search(r'<ksj:position xlink:href="#([^"]+)"', block)
            if not name or not ref or ref.group(1) not in points:
                continue
            lat, lng = points[ref.group(1)]
            code = pick(block, "prefectureCode")
            kind = pick(block, "turismResorceKindName")
            out.append({
                "name": norm(name),
                "lat": lat, "lng": lng,
                "prefecture": prefecture_of(code),
                "address": norm(pick(block, "address")),
                "kind": norm(kind) if kind and kind != "‐" else "",
                "source": "国土数値情報",
                "url": "",
            })
    return out


def pick(block, tag):
    m = re.search(r"<ksj:%s[^>]*>([^<]*)</ksj:%s>" % (tag, tag), block)
    return m.group(1) if m else ""


def prefecture_of(code):
    try:
        i = int(code)
    except (TypeError, ValueError):
        return ""
    return PREFECTURES[i - 1] if 1 <= i <= 47 else ""


def read_kml(path):
    """観光資源台帳の KML。**build からは呼びません。**

    再配布の条件がはっきりしないため、収録から外しました
    （tools/drop_daicho.py）。読み方の記録として関数だけ残しています。
    """
    text = io.open(path, encoding="utf-8").read()
    out = []
    for m in re.finditer(r"<Placemark>(.*?)</Placemark>", text, re.S):
        block = m.group(1)
        name = re.search(r"<name>(.*?)</name>", block, re.S)
        if not name:
            continue
        data = dict(re.findall(
            r'<Data name="([^"]+)">\s*<value>(.*?)</value>', block, re.S))
        lat = to_float(data.get("緯度"))
        lng = to_float(data.get("経度"))
        if lat is None or lng is None:
            # 座標が Data に無ければ <coordinates> から
            c = re.search(r"<coordinates>\s*([-\d.]+),([-\d.]+)", block)
            if not c:
                continue
            lng, lat = float(c.group(1)), float(c.group(2))
        address = norm(data.get("住所", ""))
        out.append({
            "name": norm(unescape(name.group(1))),
            "lat": lat, "lng": lng,
            "prefecture": prefecture_from_address(address),
            "address": address,
            "kind": norm(data.get("資源タイプ", "")),
            "source": "観光資源台帳",
            "url": norm(unescape(data.get("URL", ""))),
        })
    return out


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def unescape(s):
    return (s.replace("&amp;", "&").replace("&lt;", "<")
             .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))


def prefecture_from_address(address):
    for p in PREFECTURES:
        if address.startswith(p):
            return p
    return ""


def read_curated():
    """これまでの収録データ。営業時間まで確認済みなので、そのまま残します。"""
    src = os.path.join(WEB, "js", "sample-data.js")
    text = io.open(src, encoding="utf-8").read()
    i = text.index("SAMPLE_KB = ") + len("SAMPLE_KB = ")
    body = text[i:].rstrip().rstrip(";")
    return json.loads(body)


# --- 整形 -------------------------------------------------------------------

MUNI = re.compile(r"([^\s]*?[市区町村])")


def municipality(address, prefecture):
    """住所から市区町村を取り出します。エリアのまとまりの単位にします。"""
    body = address[len(prefecture):] if address.startswith(prefecture) else address
    # 「斜里郡斜里町」は郡を落として「斜里町」に。エリア名として読みにくいので。
    body = re.sub(r"^.*?郡", "", body)
    m = MUNI.search(body)
    if not m:
        return ""
    name = m.group(1)
    # 「◯◯市◯◯区」は市までを単位にします（区ごとに割ると細かすぎるため）
    m2 = re.match(r"^(.*?市)", name)
    return m2.group(1) if m2 else name


def fill_missing_prefectures(records, reference):
    """住所に都道府県が書かれていないものを、座標から補います。

    台帳の住所は「帯広市西13条…」のように県名を省くことがあり、
    そのままだと 156 件が行き場を失って捨てられていました。
    県名の分かっている点（国土数値情報）のうち、いちばん近いものに合わせます。
    """
    known = [(r["lat"], r["lng"], r["prefecture"]) for r in reference
             if r["prefecture"]]
    filled = 0
    for r in records:
        if r["prefecture"]:
            continue
        best = None
        for lat, lng, pref in known:
            # 粗く絞ってから距離を測る（全件との距離計算は無駄が多いため）
            if abs(lat - r["lat"]) > 1.2 or abs(lng - r["lng"]) > 1.2:
                continue
            d = haversine((lat, lng), (r["lat"], r["lng"]))
            if best is None or d < best[0]:
                best = (d, pref)
        if best and best[0] < 60:
            r["prefecture"] = best[1]
            filled += 1
    return filled


def categorize(kind, name):
    if kind in KIND_TO_CATEGORY:
        return KIND_TO_CATEGORY[kind]
    for word, cat in (("温泉", "温泉"), ("城", "城"), ("神社", "神社"),
                      ("大社", "神社"), ("寺", "寺院"), ("公園", "公園"),
                      ("美術館", "美術館"), ("博物館", "博物館"),
                      ("滝", "滝"), ("岬", "海岸"), ("海岸", "海岸"),
                      ("湖", "湖"), ("峡", "渓谷"), ("渓", "渓谷"),
                      ("山", "山"), ("展望", "展望台"), ("灯台", "灯台"),
                      ("市場", "市場"), ("商店街", "商店街")):
        if word in name:
            return cat
    return "観光名所"


def fame_of(rec, category):
    name = rec["name"]
    if any(w in name for w in MAJOR_WORDS):
        return "major"
    if rec["source"] == "観光資源台帳":
        # 台帳に載っている＝取り上げられている場所
        return "known" if not any(w in name for w in KNOWN_WORDS) else "major"
    if rec["kind"]:
        return "known"
    return "hidden"


FAME_SCORE = {"major": 82, "known": 55, "hidden": 26}


def dedupe_key(name):
    """表記ゆれを吸収した見出し。

    「道後温泉本館」「道後温泉の道後温泉本館」「道後温泉本館・椿の湯」は
    同じ場所です。修飾を落として突き合わせます。
    """
    k = re.sub(r"[\s　・（）()「」]", "", name)
    k = re.sub(r"^.{2,6}の", "", k)          # 「◯◯の△△」の「◯◯の」
    k = re.sub(r"(を除く|など|ほか)$", "", k)
    return k


def dedupe(records, block_keys=frozenset()):
    """同じ場所を二重に持たない。

    旅程に同じ名前が2回出るのは、そのまま不具合として見えます
    （「知床半島の海岸」が2回並んでいました）。同じ名前は距離に関係なく
    1件に寄せ、名前が含み合うもの（「道後温泉本館」と
    「道後温泉本館・椿の湯」）も近ければ1件にします。

    block_keys には、すでに確認済みの収録にある名前を渡します。
    そちらを残し、外部データ側を落とします。
    """
    priority = {"観光資源台帳": 0, "国土数値情報": 1}
    ordered = sorted(records, key=lambda r: priority.get(r["source"], 2))

    kept = {}
    merged = 0
    for r in ordered:
        key = dedupe_key(r["name"])
        if key in block_keys:
            merged += 1
            continue
        cur = kept.get(key)
        if cur:
            merged += 1
            if not cur["url"] and r["url"]:
                cur["url"] = r["url"]
            if not cur["kind"] and r["kind"]:
                cur["kind"] = r["kind"]
            continue
        kept[key] = r

    # 名前が含み合い、かつ近いものを寄せる。
    # 全件どうしを突き合わせると2万件で終わらないので、
    # 約2km四方の升目に入れて、隣の升だけを見ます。
    CELL = 0.02
    grid = defaultdict(list)
    out = []
    for r in sorted(kept.values(), key=lambda x: -len(dedupe_key(x["name"]))):
        key = dedupe_key(r["name"])
        gx, gy = int(r["lat"] / CELL), int(r["lng"] / CELL)
        dup = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for k in grid.get((gx + dx, gy + dy), ()):
                    kk = k["_key"]
                    if (key in kk or kk in key) and haversine(
                            (k["lat"], k["lng"]), (r["lat"], r["lng"])) < 1.5:
                        dup = True
                        break
                if dup:
                    break
            if dup:
                break
        if dup:
            merged += 1
            continue
        r["_key"] = key
        grid[(gx, gy)].append(r)
        out.append(r)
    for r in out:
        r.pop("_key", None)
    return out, merged


# --- エリアにまとめる -------------------------------------------------------

MAX_RADIUS_KM = 14.0     # これより広がったら割る
MIN_SPOTS = 2            # これ未満のかたまりは、近いエリアへ寄せる
MAX_SPOTS_PER_REGION = 40   # 1エリアに詰め込みすぎない（読み込みを軽く保つ）
ABSORB_KM = 45.0         # 小さなまとまりを、この距離までなら近隣へ寄せる

# 街らしい分類（宿の目安になる地点を決めるのに使います）
TOWN_CATEGORIES = {"町並み", "商店街", "市場", "グルメ", "博物館", "美術館",
                   "温泉", "建築", "商業施設", "テーマパーク", "観光名所"}


def cluster(records):
    """市区町村ごとにまとめ、広すぎるものは距離で割ります。"""
    groups = defaultdict(list)
    for r in records:
        key = (r["prefecture"], municipality(r["address"], r["prefecture"]))
        groups[key].append(r)

    clusters = []
    for (pref, muni), items in groups.items():
        if not pref:
            continue
        for part in split_by_distance(items):
            clusters.append({"prefecture": pref, "muni": muni, "items": part})
    return absorb_small(clusters)


def absorb_small(clusters):
    """数の少ないかたまりを、近くのエリアへ寄せます。

    捨てると、宗谷岬のように「その市に数件しか無い有名な場所」が
    まるごと消えます（実際に消えていました）。同じ都道府県で
    いちばん近いエリアに合流させ、行き場が無いものだけ落とします。
    """
    big = [c for c in clusters if len(c["items"]) >= MIN_SPOTS]
    small = [c for c in clusters if len(c["items"]) < MIN_SPOTS]
    for c in big:
        c["center"] = centroid([(r["lat"], r["lng"]) for r in c["items"]])
    orphan = 0
    for c in small:
        here = centroid([(r["lat"], r["lng"]) for r in c["items"]])
        best = None
        for t in big:
            if t["prefecture"] != c["prefecture"]:
                continue
            d = haversine(here, t["center"])
            if best is None or d < best[0]:
                best = (d, t)
        if best and best[0] <= ABSORB_KM:
            best[1]["items"].extend(c["items"])
        elif any(r["source"] == "観光資源台帳" for r in c["items"]):
            # 近くに寄せ先が無くても、台帳に載っている場所は残します。
            # 宗谷岬のように「その市に数件しか無いが、誰もが知っている」
            # 場所が、件数の足切りで丸ごと消えていました。
            c["center"] = here
            big.append(c)
        else:
            orphan += len(c["items"])
    sys.stderr.write("小さなまとまりを合流。行き場の無い %d件は除外\n" % orphan)
    return big


def split_by_distance(items):
    """かたまりが広すぎるときに割る。単純な逐次割り当てで足ります。"""
    parts = []
    for r in sorted(items, key=lambda x: (x["lat"], x["lng"])):
        placed = False
        for p in parts:
            c = p["center"]
            if haversine(c, (r["lat"], r["lng"])) <= MAX_RADIUS_KM:
                p["items"].append(r)
                n = len(p["items"])
                p["center"] = ((c[0] * (n - 1) + r["lat"]) / n,
                               (c[1] * (n - 1) + r["lng"]) / n)
                placed = True
                break
        if not placed:
            parts.append({"center": (r["lat"], r["lng"]), "items": [r]})
    return [p["items"] for p in parts]


def centroid(points):
    return (sum(p[0] for p in points) / len(points),
            sum(p[1] for p in points) / len(points))


def build(p12_dir, out_dir):
    curated = read_curated()
    p12 = read_p12(p12_dir)
    sys.stderr.write("読み込み: 国土数値情報 %d件 / 収録済み %d件\n"
                     % (len(p12), len(curated["spots"])))

    # 元データにも壊れた座標が混じります（経度が 133.3 ではなく 33.3 など）。
    # 推測で直すと、もっともらしい嘘になります。落として件数を伝えます。
    before = len(p12)
    p12 = [r for r in p12 if in_japan(r)]
    dropped = before - len(p12)
    if dropped:
        sys.stderr.write("座標が日本の範囲外の %d件を除外\n" % dropped)

    filled = fill_missing_prefectures([], p12)
    sys.stderr.write("住所に県名が無い %d件を、座標から補完\n" % filled)

    # 収録済みの名前は、外部データ側から落とします（確認済みを優先）
    curated_names = {s["name"] for s in curated["spots"]}
    records, merged = dedupe(p12,
                             block_keys={dedupe_key(n) for n in curated_names})
    sys.stderr.write("重複をまとめて %d件（%d件を統合）\n" % (len(records), merged))

    clusters = cluster(records)
    sys.stderr.write("まとまり: %d\n" % len(clusters))
    # 名指しで探されやすい場所が残っているかを、その場で確かめます
    have = {r["name"] for c in clusters for r in c["items"]}
    have |= curated_names
    for probe in ("宗谷岬", "白金 青い池", "知床五湖", "道後温泉本館",
                  "兼六園", "厳島神社"):
        if probe not in have:
            sys.stderr.write("  注意: 「%s」が落ちています\n" % probe)

    regions = list(curated["regions"])
    spots = list(curated["spots"])
    used_ids = {r["id"] for r in regions}
    seq = 0

    for c in sorted(clusters, key=lambda x: -len(x["items"])):
        items = c["items"]
        seq += 1
        rid = "n%04d" % seq
        while rid in used_ids:
            seq += 1
            rid = "n%04d" % seq
        used_ids.add(rid)

        pts = [(r["lat"], r["lng"]) for r in items]
        clat, clng = centroid(pts)

        cats = [categorize(r["kind"], r["name"]) for r in items]
        # 宿の目安になる地点は、街らしいスポットの重心。
        # 無ければ全体の重心（山の上を指さないように、ここで寄せておきます）
        townish = [p for p, cat in zip(pts, cats) if cat in TOWN_CATEGORIES]
        slat, slng = centroid(townish) if townish else (clat, clng)

        name = c["muni"] or c["prefecture"]
        genres = sorted({g for cat in cats for g in CATEGORY_GENRES.get(cat, ["city"])})
        regions.append({
            "id": rid, "name": name, "prefecture": c["prefecture"],
            "prefectureId": rid, "hub": "tokyo",
            "lat": round(clat, 5), "lng": round(clng, 5),
            "station": name + "中心部",
            "stationLat": round(slat, 5), "stationLng": round(slng, 5),
            "genres": genres,
            "spotCount": min(len(items), MAX_SPOTS_PER_REGION),
            "src": "external",
        })

        # 1エリアに何百件あっても旅程には使いきれません。知名度の高い順に絞り、
        # 読み込みを軽く保ちます（エリアそのものは全部残します）。
        ranked = sorted(zip(items, cats),
                        key=lambda rc: -FAME_SCORE[fame_of(rc[0], rc[1])])
        for i, (r, cat) in enumerate(ranked[:MAX_SPOTS_PER_REGION], 1):
            fame = fame_of(r, cat)
            # region / prefecture / genres / wikipedia は読み込み時に補います。
            # 1万件以上あると、同じ文字列の繰り返しだけでMB単位になるためです。
            spot = {
                "id": "%s-%d" % (rid, i), "regionId": rid,
                "name": r["name"], "category": cat,
                "lat": round(r["lat"], 5), "lng": round(r["lng"], 5),
                "fame_tier": fame,
                "src": "kokudo" if r["source"] == "国土数値情報" else "daicho",
            }
            if r["url"]:
                spot["url"] = r["url"]
            # 住所は、エリア名から分かること以上の中身があるときだけ持ちます
            rest = r["address"]
            for prefix in (c["prefecture"], name):
                if rest.startswith(prefix):
                    rest = rest[len(prefix):]
            if rest:
                spot["description"] = rest
            spots.append(spot)

    write_shards(out_dir, regions, spots)
    return regions, spots


SHARD_SIZE = 3000


def write_shards(out_dir, regions, spots):
    os.makedirs(out_dir, exist_ok=True)
    dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

    io.open(os.path.join(out_dir, "regions.json"), "w", encoding="utf-8").write(
        dump({"regions": regions}))

    shards = []
    for i in range(0, len(spots), SHARD_SIZE):
        part = spots[i:i + SHARD_SIZE]
        fn = "spots-%02d.json" % (i // SHARD_SIZE)
        io.open(os.path.join(out_dir, fn), "w", encoding="utf-8").write(
            dump({"spots": part}))
        shards.append({"file": fn, "count": len(part)})

    io.open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8").write(
        dump({
            "regionsFile": "regions.json",
            "shards": shards,
            "counts": {"regions": len(regions), "spots": len(spots)},
            "sources": [
                {"name": "国土数値情報 観光資源（国土交通省）",
                 "url": "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P12.html"},
                {"name": "観光資源台帳（日本観光振興協会）",
                 "url": "https://tabi.jtb.or.jp"},
                {"name": "本アプリの収録データ（手作業で確認）", "url": ""},
            ],
        }))
    total = sum(os.path.getsize(os.path.join(out_dir, f))
                for f in os.listdir(out_dir))
    sys.stderr.write("出力: %d エリア / %d スポット / %.1f MB\n"
                     % (len(regions), len(spots), total / 1048576))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write(__doc__)
        raise SystemExit(2)
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(WEB, "kb")
    build(sys.argv[1], out)
