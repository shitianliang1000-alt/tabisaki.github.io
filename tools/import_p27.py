#!/usr/bin/env python3
# 国土数値情報「文化施設」(P27) を、収録済みの知識ベースに足す。
#
# 何を足して、何を足さないか
# --------------------------
# P27 は 55,912件ありますが、その大半は体育館・野球場・庭球場です。
# 旅行者が「行きたい」と思う場所ではありません。全部入れると、
# 「四国で自然を楽しみたい」に町民体育館が並びます。件数は増えても、
# 提案は悪くなります。
#
# 入れるのは、観光の目的地になり得る分類だけです（下の KEEP）。
#
# 重複について
# ------------
# 既存の 15,047件と突き合わせます。名前だけでは足りません。
# 「〇〇市立美術館」は各地にあります。**名前が同じでも、離れていれば
# 別の場所**です。名前（表記ゆれを吸収）と座標の両方で見ます。
#
#   同じ見出し ＋ 5km 以内   → 同じ場所とみなして落とす
#   同じ見出し ＋ 遠い       → 別の場所として残す
#
# 使いかた
#   python3 tools/import_p27.py /path/to/P27-13 --dry-run
#   python3 tools/import_p27.py /path/to/P27-13

import argparse
import json
import math
import os
import re
import struct
import sys

# 観光の目的地になり得る分類だけを入れます。
# コードは実データを集計して確かめたものです（tools/README を参照）。
KEEP = {
    "03001": ("美術館", "art"),
    "03002": ("博物館", "history"),
    "03141": ("スキー場", "nature"),
    "03148": ("海水浴場", "sea"),
}

# 名前で見て、明らかに観光地でないもの。分類が合っていても落とします。
# 「◯◯市立図書館」が 03002 に入っていることがあります。
EXCLUDE_WORDS = (
    "体育館", "野球場", "庭球場", "運動場", "グラウンド", "グランド",
    "プール", "武道館", "相撲場", "射撃場", "ゲートボール",
    "図書館", "公民館", "集会所", "研修センター", "勤労",
    "小学校", "中学校", "高等学校", "大学", "給食",
    "斎場", "火葬", "clean", "クリーンセンター", "浄化",
    "車庫", "倉庫", "агентство",
)

PREFECTURES = [
    "", "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]

# 同じ名前でも、これより離れていれば別の場所とみなします。
SAME_PLACE_KM = 5.0


def read_dbf(path):
    """DBF を読みます（依存を増やさないため、自前で解きます）。"""
    with open(path, "rb") as f:
        head = f.read(32)
        nrec, hlen, rlen = struct.unpack("<IHH", head[4:12])
        fields = []
        while True:
            fd = f.read(32)
            if fd[0:1] == b"\x0d":
                break
            fields.append((fd[:11].split(b"\x00")[0].decode("ascii"), fd[16]))
        f.seek(hlen)
        out = []
        for _ in range(nrec):
            rec = f.read(rlen)
            if len(rec) < rlen:
                break
            off, row = 1, {}
            for name, ln in fields:
                row[name] = rec[off:off + ln].decode("cp932", "replace").strip()
                off += ln
            out.append(row)
        return out


def read_shp_points(path):
    """点シェープの座標を、レコード順に読みます。

    P27 は Point（type 1）だけです。他の型が来たら、そこで止めます。
    黙って読み飛ばすと、属性と座標の対応がずれます。
    """
    pts = []
    with open(path, "rb") as f:
        f.seek(100)                       # ヘッダは 100 バイト固定
        while True:
            head = f.read(8)
            if len(head) < 8:
                break
            _, length = struct.unpack(">II", head)
            body = f.read(length * 2)
            (shape_type,) = struct.unpack("<I", body[:4])
            if shape_type == 0:           # Null shape
                pts.append(None)
                continue
            if shape_type != 1:
                raise SystemExit("点以外の図形が入っています（type=%d）" % shape_type)
            x, y = struct.unpack("<dd", body[4:20])
            pts.append((y, x))            # (lat, lng)
    return pts


def haversine(a, b):
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(h))


def dedupe_key(name):
    """表記ゆれを吸収した見出し。build_kb.py と同じ規則です。"""
    k = re.sub(r"[\s　・（）()「」\-－ー]", "", name)
    k = re.sub(r"^.{2,6}の", "", k)
    k = re.sub(r"(を除く|など|ほか)$", "", k)
    # 「市立」「町立」「県立」は、同じ場所の書きかたの違いになりがちです
    k = re.sub(r"(都|道|府|県|市|区|町|村)立", "", k)
    return k


def norm(s):
    return re.sub(r"\s+", " ", (s or "").replace("　", " ")).strip()


def in_japan(lat, lng):
    return 20.0 <= lat <= 46.5 and 122.0 <= lng <= 154.0


def load_kb(kb_dir):
    index = json.load(open(os.path.join(kb_dir, "index.json"), encoding="utf-8"))
    raw = json.load(open(os.path.join(kb_dir, "regions.json"), encoding="utf-8"))
    regions = raw if isinstance(raw, list) else raw.get("regions", [])
    spots = []
    for shard in index["shards"]:
        data = json.load(open(os.path.join(kb_dir, shard["file"]), encoding="utf-8"))
        spots.extend(data if isinstance(data, list) else data.get("spots", []))
    return index, regions, spots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="P27-13 フォルダ（.shp と .dbf があるところ）")
    ap.add_argument("--kb", default="kb", help="知識ベースの場所")
    ap.add_argument("--dry-run", action="store_true", help="書かずに件数だけ見る")
    args = ap.parse_args()

    base = None
    for fn in os.listdir(args.src):
        if fn.lower().endswith(".shp"):
            base = os.path.join(args.src, fn[:-4])
    if not base:
        raise SystemExit(".shp が見つかりません: %s" % args.src)

    rows = read_dbf(base + ".dbf")
    pts = read_shp_points(base + ".shp")
    if len(rows) != len(pts):
        raise SystemExit("属性 %d件 と 座標 %d件 が合いません" % (len(rows), len(pts)))
    sys.stderr.write("P27 を読み込み: %d件\n" % len(rows))

    # --- 1. 観光の目的地になり得るものだけに絞る --------------------------
    cand = []
    by_class = {}
    for row, pt in zip(rows, pts):
        code = row.get("P27_004") or row.get("P27_003")
        if code not in KEEP or pt is None:
            continue
        name = norm(row.get("P27_005"))
        if not name or any(w in name for w in EXCLUDE_WORDS):
            continue
        lat, lng = pt
        if not in_japan(lat, lng):
            continue
        category, genre = KEEP[code]
        muni = row.get("P27_001") or ""
        pref = PREFECTURES[int(muni[:2])] if muni[:2].isdigit() else ""
        cand.append({
            "name": name, "lat": lat, "lng": lng,
            "prefecture": pref,
            "address": norm(row.get("P27_006")),
            "category": category, "genres": [genre],
            "source": "国土数値情報 文化施設(P27)",
        })
        by_class[category] = by_class.get(category, 0) + 1
    sys.stderr.write("観光に使える分類だけに絞る: %d件 %s\n" % (len(cand), by_class))

    # --- 2. P27 の中の重複を落とす ----------------------------------------
    #     同じ施設が複数の分類で登録されていることがあります。
    seen = {}
    uniq = []
    for r in cand:
        key = dedupe_key(r["name"])
        hit = seen.get(key)
        if hit and haversine((hit["lat"], hit["lng"]), (r["lat"], r["lng"])) < SAME_PLACE_KM:
            continue
        seen[key] = r
        uniq.append(r)
    sys.stderr.write("P27 内の重複を落とす: %d件（%d件 重複）\n"
                     % (len(uniq), len(cand) - len(uniq)))

    # --- 3. 収録済みと突き合わせる ----------------------------------------
    #     名前だけでは足りません。「〇〇市立美術館」は各地にあります。
    index, regions, spots = load_kb(args.kb)
    sys.stderr.write("収録済み: %dエリア / %dスポット\n" % (len(regions), len(spots)))

    existing = {}
    for s in spots:
        existing.setdefault(dedupe_key(s["name"]), []).append(s)

    fresh, dup = [], 0
    for r in uniq:
        hits = existing.get(dedupe_key(r["name"]), [])
        if any(haversine((h["lat"], h["lng"]), (r["lat"], r["lng"])) < SAME_PLACE_KM
               for h in hits):
            dup += 1
            continue
        fresh.append(r)
    sys.stderr.write("収録済みと重複: %d件 / 新しく足せるもの: %d件\n" % (dup, len(fresh)))

    # --- 4. どのエリアに属するかを決める ----------------------------------
    #     いちばん近いエリアの駅から 30km 以内なら、そのエリアに入れます。
    #     どのエリアからも遠いものは入れません。エリアが無いスポットは、
    #     検索には出ても旅程に組み込めないためです。
    placed, orphan = [], 0
    for r in fresh:
        best, best_km = None, 1e9
        for g in regions:
            km = haversine((g["stationLat"], g["stationLng"]), (r["lat"], r["lng"]))
            if km < best_km:
                best, best_km = g, km
        if best is None or best_km > 30:
            orphan += 1
            continue
        r["regionId"] = best["id"]
        r["region"] = best["name"]
        if not r["prefecture"]:
            r["prefecture"] = best.get("prefecture", "")
        r["distanceKm"] = round(best_km, 1)
        placed.append(r)
    sys.stderr.write("エリアに入った: %d件 / どのエリアからも遠い: %d件\n"
                     % (len(placed), orphan))

    if args.dry_run:
        sys.stderr.write("\n--dry-run なので書き込みません。\n")
        for r in placed[:15]:
            sys.stderr.write("  %s（%s / %s・%skm）\n"
                             % (r["name"], r["category"], r["region"], r["distanceKm"]))
        return

    write(args.kb, index, placed, len(spots))


# 分類ごとの、だいたいの滞在時間と料金。実データが無いものに
# それらしい数字を書かないため、確度は "estimated" として持ちます。
DEFAULTS = {
    "美術館": {"dwell": 75, "open": 9.5, "close": 17.0, "fee": 800},
    "博物館": {"dwell": 70, "open": 9.0, "close": 17.0, "fee": 600},
    "スキー場": {"dwell": 180, "open": 8.5, "close": 16.5, "fee": 5000},
    "海水浴場": {"dwell": 90, "open": 0.0, "close": 24.0, "fee": 0},
}


def write(kb_dir, index, placed, existing_count):
    """新しいシャードを1つ足します。既存のシャードは触りません。"""
    shard = "spots-p27.json"
    out = []
    for i, r in enumerate(placed):
        d = DEFAULTS.get(r["category"], {"dwell": 60, "open": 9.0, "close": 17.0})
        out.append({
            "id": "p27-%d" % i,
            "regionId": r["regionId"], "region": r["region"],
            "name": r["name"], "category": r["category"], "genres": r["genres"],
            "lat": round(r["lat"], 6), "lng": round(r["lng"], 6),
            "prefecture": r["prefecture"],
            "description": "%s（%s）。%s" % (
                r["name"], r["category"],
                r["address"] or "所在地の詳細は未収録です。"),
            "fame_score": 40, "fame_tier": "hidden",
            "dwell": d["dwell"], "open": d["open"], "close": d["close"],
            "fee": d.get("fee", 0),
            # 出どころと確度。営業時間と料金は分類ごとの目安であって、
            # 確認した値ではありません。画面ではそう表示されます。
            # 出どころの名前は全行で同じなので、シャード側に1つだけ持ちます
            # （3,638行に同じ文字列を書くと、それだけで100KB を超えます）。
            "source": "estimated",
        })
    # 既存のシャードと同じ形にします。裸の配列で書くと、読み込み側の
    # `doc.spots` が undefined になり、**1件も足されないまま件数だけ
    # 増えて見えます**（index.json の counts は別に持っているため）。
    path = os.path.join(kb_dir, shard)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"spots": out,
                   "dataSource": "国土数値情報 文化施設(P27-13)"},
                  f, ensure_ascii=False, separators=(",", ":"))

    if not any(s["file"] == shard for s in index["shards"]):
        index["shards"].append({"file": shard, "count": len(out)})
    else:
        for s in index["shards"]:
            if s["file"] == shard:
                s["count"] = len(out)
    index["counts"]["spots"] = existing_count + len(out)
    src = {"name": "国土数値情報 文化施設（国土交通省）",
           "url": "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P27.html"}
    if src not in index["sources"]:
        index["sources"].append(src)
    with open(os.path.join(kb_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)
    sys.stderr.write("書き込み: %s に %d件、合計 %d スポット\n"
                     % (shard, len(out), index["counts"]["spots"]))


if __name__ == "__main__":
    main()
