# -*- coding: utf-8 -*-
"""既存の sample-data.js に、tools/extra_data.py のエリアを足して書き戻す。

既存分は触りません（生成し直すと手作業で確認した値がずれるため）。
追加分だけを同じ形に整えて連結します。
"""
import io, json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
SRC = os.path.join(WEB, "js", "sample-data.js")
sys.path.insert(0, HERE)
import extra_data as ex   # noqa: E402

HEADER = """// 収録データ（手作業で確認した実データ）。config.js の KB_INDEX_URL を
// 設定すると、公開知識ベースに切り替わります。
// dwell/open/close/fee は実データで、分類ごとの目安ではありません。
// 追加エリア（tools/extra_data.py）の座標は約100m精度、営業時間・料金は
// 一般的な公表値です。訪問前の確認をお願いする旨は画面にも出しています。

export const SAMPLE_KB = """

CATEGORY_GENRES = {
    "温泉": ["onsen"], "温泉地": ["onsen"],
    "神社": ["history"], "寺院": ["history"], "教会": ["history"],
    "城": ["history"], "史跡": ["history"], "町並み": ["history"],
    "庭園": ["nature"], "公園": ["nature"], "自然": ["nature"],
    "渓谷": ["nature"], "滝": ["nature"], "登山": ["nature"],
    "湖": ["sea"], "海岸": ["sea"], "漁港": ["sea"], "水族館": ["sea"],
    "美術館": ["art"], "博物館": ["art"], "文化施設": ["art"], "建築": ["art"],
    "商店街": ["food"], "市場": ["food"], "グルメ": ["food"],
    "展望台": ["view"], "灯台": ["view"],
    "商業施設": ["city"], "乗り物": ["city"], "ロープウェイ": ["view"],
}
FAME_SCORE = {"major": 86, "known": 58, "hidden": 28}

def haversine(a, b):
    R = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(h))

def load_existing():
    text = io.open(SRC, encoding="utf-8").read()
    i = text.index("SAMPLE_KB = ") + len("SAMPLE_KB = ")
    body = text[i:].rstrip()
    if body.endswith(";"):
        body = body[:-1]
    return json.loads(body)

def build():
    kb = load_existing()
    have = {r["id"] for r in kb["regions"]}
    problems = []
    added_r = added_s = 0

    for (rid, name, pref, lat, lng, station, st_lat, st_lng,
         genres, tagline, desc) in ex.REGIONS:
        if rid in have:
            problems.append("エリアIDが重複: %s" % rid)
            continue
        spots = ex.SPOTS.get(rid, [])
        if not spots:
            problems.append("スポットが無いエリア: %s" % rid)
            continue
        kb["regions"].append({
            "id": rid, "name": name, "prefecture": pref, "prefectureId": rid,
            "hub": "tokyo", "lat": lat, "lng": lng,
            "station": station, "stationLat": st_lat, "stationLng": st_lng,
            "genres": list(genres), "spotCount": len(spots),
            "tagline": tagline, "description": desc,
        })
        added_r += 1
        for n, (sname, cat, slat, slng, dwell, op, cl, fee, fame,
                sdesc) in enumerate(spots, 1):
            d = haversine((lat, lng), (slat, slng))
            if d > 70:
                problems.append("%s の %s がエリア中心から %.0fkm 離れています"
                                % (rid, sname, d))
            if not (0 <= op < cl <= 24):
                problems.append("%s の %s の営業時間が不正 (%s-%s)"
                                % (rid, sname, op, cl))
            kb["spots"].append({
                "id": "%s-%d" % (rid, n), "regionId": rid, "region": name,
                "name": sname, "category": cat,
                "genres": CATEGORY_GENRES.get(cat, ["city"]),
                "lat": slat, "lng": slng,
                "prefecture": pref, "prefectureId": rid,
                "description": sdesc, "wikipedia": sname,
                "fame_score": FAME_SCORE[fame], "fame_tier": fame,
                "dwell": dwell, "open": float(op), "close": float(cl),
                "fee": fee,
            })
            added_s += 1

    if problems:
        for p in problems:
            sys.stderr.write("NG: %s\n" % p)
        raise SystemExit(1)

    out = HEADER + json.dumps(kb, ensure_ascii=False, separators=(",", ":")) + ";\n"
    io.open(SRC, "w", encoding="utf-8").write(out)
    print("追加: %d エリア / %d スポット → 合計 %d エリア / %d スポット"
          % (added_r, added_s, len(kb["regions"]), len(kb["spots"])))

if __name__ == "__main__":
    build()
