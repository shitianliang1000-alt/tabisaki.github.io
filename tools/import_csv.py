# -*- coding: utf-8 -*-
"""data/extra-spots.csv を収録に足す。

中身は、文化財・灯台・城跡・ダム・道の駅・滝です。出どころは

    文化財(Wikipedia都道府県指定文化財一覧)      4686件
    Wikipedia(都道府県別灯台一覧)                1260件
    Wikipedia(日本100名城/続100名城/…)            985件
    国土交通省川の防災情報/ダムデータ             770件
    Wikipedia(道の駅一覧)                         129件
    Wikipedia(日本の滝百選)                        80件

**全部は入れません。**座標が信用できない行があるためです。

    旧函館博物館1号   41.79926985024154, 140.83035502898554
    旧函館博物館2号   41.79926985024154, 140.83035502898554   ← 同じ

小数第14位まで同じ座標が、7910行中6818行あります。多いところでは
80件が1点に重なっています（佐渡市の文化財）。これは現地の座標ではなく、
市区町村の代表点を当てはめたものです。旅程では座標がそのまま移動時間に
なるので、代表点を置くと「駅から徒歩5分」と出したその場所が、
実際には20km先ということが起きます。名前だけ合っていても意味がありません。

そこで、**座標が他の行と1つも重ならない行だけ**を入れます（1092件）。
ダムは全件が固有の座標を持っていて、そのまま残ります。

    python3 tools/import_csv.py --check   確認するだけ
    python3 tools/import_csv.py --write   足して書き戻す
"""
import collections
import csv
import glob
import json
import os
import sys

from dedupe_spots import same_place
from landmarks import pick_region

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
CSV_PATH = os.path.join(WEB, "data", "extra-spots.csv")

SRC = "opendata"

# CSV の分類 → 収録の分類。収録側に無い名前を作ると、滞在時間も
# ジャンルも既定値になって、どれも同じ扱いになります。
CATEGORY = {
    "史跡": "史跡",
    "天然記念物": "天然記念物",
    "灯台": "灯台",
    "建造物": "建築",
    "城跡": "城",
    "城": "城",
    "ダム": "ダム",
    "名勝": "名勝",
    "名勝及び天然記念物": "名勝",
    "道の駅": "道の駅",
    "滝": "滝",
}

# 日本の滝百選は、選ばれている時点で広く知られた行き先です。
# それ以外は hidden（穴場）にします。数が多いので、まぜかたの
# スライダーを「定番」に寄せたときに埋もれてほしくありません。
KNOWN_SOURCES = {"Wikipedia(日本の滝百選)"}

SOURCE_LINKS = [
    {"name": "Wikipedia（文化財・灯台・城・道の駅・滝の一覧）",
     "url": "https://ja.wikipedia.org/"},
    {"name": "川の防災情報 ダムデータ（国土交通省）",
     "url": "https://www.river.go.jp/"},
]


def load_shards():
    out = {}
    for path in sorted(glob.glob(os.path.join(WEB, "kb", "spots-*.json"))):
        with open(path, encoding="utf-8") as f:
            out[path] = json.load(f)
    return out


def read_csv():
    with open(CSV_PATH, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def unique_coordinates(rows):
    """他の行と座標が重ならない行だけ。重なりは市区町村の代表点です。"""
    seen = collections.Counter((r["緯度"], r["経度"]) for r in rows)
    return [r for r in rows if seen[(r["緯度"], r["経度"])] == 1]


def main(write):
    rows = read_csv()
    rows = [r for r in rows if r["カテゴリ"] in CATEGORY]
    usable = unique_coordinates(rows)
    print(f"CSV {len(rows)}件 → 座標が固有のもの {len(usable)}件"
          f"（重なっていた {len(rows) - len(usable)}件は入れません）")

    shards = load_shards()
    existing = [s for doc in shards.values() for s in doc["spots"]]
    with open(os.path.join(WEB, "kb", "regions.json"), encoding="utf-8") as f:
        regions = json.load(f)

    # 近いものだけ突き合わせます。全件どうしを比べると 1092×15891 になり、
    # しかも遠くの同名（「城山」など）を同じものにしてしまいます。
    grid = {}
    for s in existing:
        grid.setdefault((round(s["lat"] / 0.05), round(s["lng"] / 0.05)),
                        []).append(s)

    add, skip, orphan = [], [], []
    taken = []
    for r in usable:
        lat, lng = float(r["緯度"]), float(r["経度"])
        probe = {"name": r["名称"], "lat": lat, "lng": lng}
        gx, gy = round(lat / 0.05), round(lng / 0.05)
        near = [x for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for x in grid.get((gx + dx, gy + dy), [])]
        if any(same_place(probe, s) for s in near + taken):
            skip.append(r["名称"])
            continue
        region = pick_region(regions["regions"], lat, lng, r["都道府県名"])
        if not region:
            orphan.append(f"{r['名称']}（{r['都道府県名']}）")
            continue
        spot = {
            "id": f"csv-{r['id'][3:]}",
            "regionId": region["id"],
            "name": r["名称"],
            "category": CATEGORY[r["カテゴリ"]],
            "lat": round(lat, 5),
            "lng": round(lng, 5),
            "fame_tier": "known" if r["データソース"] in KNOWN_SOURCES
                         else "hidden",
            "src": SRC,
        }
        if r["情報"]:
            spot["description"] = r["情報"]
        add.append(spot)
        taken.append(spot)

    by_cat = collections.Counter(s["category"] for s in add)
    print(f"足す {len(add)}件 / すでにある {len(skip)}件"
          f" / 置き場所が無い {len(orphan)}件")
    for cat, n in by_cat.most_common():
        print(f"  {cat} {n}件")
    for o in orphan[:10]:
        print(f"  置き場所なし: {o}")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    path = os.path.join(WEB, "kb", "spots-05.json")
    shards[path]["spots"].extend(add)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(shards[path], f, ensure_ascii=False, separators=(",", ":"))

    per_region, total = {}, 0
    for p, doc in shards.items():
        total += len(doc["spots"])
        for s in doc["spots"]:
            per_region[s["regionId"]] = per_region.get(s["regionId"], 0) + 1

    for reg in regions["regions"]:
        if "spotCount" in reg:
            reg["spotCount"] = per_region.get(reg["id"], 0)
    with open(os.path.join(WEB, "kb", "regions.json"), "w",
              encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, separators=(",", ":"))

    ipath = os.path.join(WEB, "kb", "index.json")
    with open(ipath, encoding="utf-8") as f:
        index = json.load(f)
    by_file = {os.path.basename(p): len(d["spots"]) for p, d in shards.items()}
    for shard in index.get("shards", []):
        if shard["file"] in by_file:
            shard["count"] = by_file[shard["file"]]
    if "counts" in index:
        index["counts"]["spots"] = total
    have = {s["name"] for s in index.get("sources", [])}
    index["sources"] = index.get("sources", []) + [
        s for s in SOURCE_LINKS if s["name"] not in have]
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n収録 {total}件になりました。")


if __name__ == "__main__":
    main(write="--write" in sys.argv)
