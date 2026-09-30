# -*- coding: utf-8 -*-
"""座標が引けなかった観光地の名前に、Overture Maps から座標を付けて足す。

    python3 tools/fetch_overture_places.py             日本の施設を取り出す
    python3 tools/import_overture_places.py --check    確認するだけ
    python3 tools/import_overture_places.py --write    足して書き戻す

## 前提

tools/import_tourism_list.py（ウィキペディア）と tools/import_osm_tourlist.py
（OpenStreetMap）で座標が引けなかった名前を、Overture Maps の施設データ
（343万件）と突き合わせます。**収録にすでに入った名前は飛ばします**ので、
順番は問いません（どちらを先に走らせても、あとから走らせても同じです）。

ご依頼は「Google マップなどで調べて」でした。Google マップは規約で使えない
ので（tools/fetch_overture_places.py の冒頭に書きました）、同じ目的の
Overture を使います。

## 決め方は、ウィキペディア・OSM と共通です

tools/place_match.py の select です。

  ・県が合う候補を先に。離れた2か所以上あれば決めない
  ・**県が合う候補が無くても、全国で1か所なら採る**（ご指示です）
  ・全国で複数なら、一覧の県にいちばん近いもの（100km以内のときだけ）

## Overture 固有の注意

**営業の状態がほぼ空です。** operating_status は 343万件のうち 299件にしか
入っていません（閉業は10件）。閉店を見分ける材料にならないので、

  ・飲食店・カフェ・バー・店（直売所を含む）・宿・駅・駐車場・行政・運動施設は
    入れません
    （js/meals.js の原則です。「閉店した店の前に立たせるのが、いちばん
     悪い結果です」）
  ・観光地の種類（寺社・史跡・公園・山・海岸・温泉・博物館…）だけを
    入れます

**住所の県も83%が空です。** 県は座標から決めます（ほかの取り込みと同じ）。

**出どころとライセンスを、1件ごとに持たせます。**

  meta / Microsoft / PinMeTo / DAC   CDLA Permissive 2.0
  Foursquare                         Apache 2.0
  AllThePlaces                       CC0 1.0

表示は「Overture Maps Foundation, overturemaps.org」です。共有の義務は
ありません。
"""
import collections
import glob
import hashlib
import json
import os
import re
import sys
import unicodedata

import duckdb

from dedupe_spots import same_place
import place_match
from place_match import select
from import_tourism_list import (
    LODGING, PrefectureLocator, clean_name, n, variants, SUFFIX_CATEGORY,
)
from import_wikipedia_lists import (
    NOT_A_DESTINATION, WIDE_BY_SUFFIX, km, load_shards, looks_unusable, register,
)

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
RAW = os.path.join(WEB, "data", "wikipedia")
OV = os.path.join(WEB, "data", "overture", "japan-places.parquet")

# 前回このファイルが入れたぶんを取り除くための印（ほかの取り込みとは別）。
SRC = "overture-tourlist"

OVERTURE_SOURCE = {"name": "Overture Maps Foundation, overturemaps.org",
                   "url": "https://docs.overturemaps.org/attribution/"}
PREF_SOURCE = {"name": "各都道府県の公式観光サイト", "url": ""}

# エリアの代表点からこれ以上離れた場所は、置きません。
MAX_PLACE_KM = 100.0

# 信頼度がこれ未満のものは採りません。Overture は、機械学習や複数の出どころ
# から作られていて、confidence はその確からしさです。一致した行では
# 0.5 未満が約900件（3%）でした。
MIN_CONFIDENCE = 0.5

# Overture の種類（taxonomy.primary）→ 収録の分類。
#
# **言い切れる種類だけ**です。ここに無い種類は、名前の終わりから決められる
# ときだけ入れます（下の EXCLUDE に無いもの）。
CATEGORY = {
    # 寺社・史跡
    "buddhist_place_of_worship": "寺院",
    "shinto_place_of_worship": "神社",
    "christian_place_of_worship": "教会",
    "church_cathedral": "教会",
    "historic_site": "史跡", "monument": "史跡",
    "landmark_and_historical_building": "史跡",
    "castle": "城",
    # 自然
    "park": "公園", "national_park": "国立公園", "nature_reserve": "自然",
    "botanical_garden": "庭園", "garden": "庭園",
    "mountain": "山", "beach": "海岸", "lake": "湖", "river": "川",
    "waterfall": "滝", "cave": "自然", "hiking_trail": "自然",
    "wildlife_sanctuary": "自然", "geographic_entities": "自然",
    "hot_springs": "温泉", "onsen": "温泉",
    # 見どころ
    "museum": "博物館", "history_museum": "博物館", "community_museum": "博物館",
    "science_museum": "博物館", "art_museum": "美術館", "art_gallery": "美術館",
    "zoo": "動物園", "aquarium": "水族館",
    "amusement_park": "遊園地", "water_park": "遊園地",
    "observatory": "展望台", "lighthouse": "灯台",
    "visitor_center": "観光名所", "bridge": "建築",
    "ski_resort": "スキー場", "boat_tour": "乗り物",
    "winery": "酒蔵", "brewery": "酒蔵", "distillery": "酒蔵",
    "dairy_farm": "牧場", "farm": "牧場", "urban_farm": "牧場",
}

# 名前の終わりから決めるもの（Overture の種類が曖昧なとき）。
AMBIGUOUS = {"religious_organization", "place_of_worship", "arts_and_entertainment",
             "sports_and_recreation", "cultural_center", None}

# 入れない種類。**行き先ではないもの・閉店を見分けられないもの**です。
# js/meals.js の原則（「閉店した店の前に立たせるのが、いちばん悪い結果です」）
# に従い、飲食店・宿・店は入れません。
EXCLUDE = re.compile(
    r"(restaurant|cafe|coffee|bar$|pub$|bakery|dessert|ice_cream|fast_food|"
    r"diner|steakhouse|lounge|karaoke|dance_club|"
    r"store|shop|shopping|market$|supermarket|mall|salon|barber|"
    r"hotel|inn$|hostel|lodg|resort$|cabin|cottage|campground|rv_park|"
    r"bed_and_breakfast|holiday_rental|"
    r"station$|parking|taxi|car_rental|atm|post_office|"
    r"government|community_and_government|school|education|library|"
    r"hospital|pharmacy|health|clinic|dentist|funeral|"
    r"stadium|court$|pool$|gym|field$|golf|sport|track|"
    r"real_estate|professional|contractor|construction|manufactur|"
    r"agricultural_service|logging|warehouse|office|service$)")


# 名前の終わりが言い切れるときは、Overture の種類より名前を信じます。
# 実データで「宇奈月神社」「飯野神社」が christian_place_of_worship（教会）に
# 入っていました。神社を教会として出すのは、行き先の取り違えです。
NAME_FIRST = (
    (("神社", "大社", "神宮", "宮"), "神社"),
    (("寺", "院", "大師", "観音"), "寺院"),
    (("教会", "聖堂"), "教会"),
    (("渓", "渓谷", "峡"), "渓谷"),
)
WORSHIP = {"buddhist_place_of_worship", "shinto_place_of_worship",
           "christian_place_of_worship", "church_cathedral",
           "religious_organization", "place_of_worship", "river",
           "hiking_trail", "geographic_entities"}


def category_of(cat, name):
    """Overture の種類と名前から、収録の分類を決めます。入れないなら None。"""
    if cat in WORSHIP or cat is None:
        for suffixes, c in NAME_FIRST:
            if name.endswith(suffixes):
                return c
    if cat in CATEGORY:
        return CATEGORY[cat]
    if cat is not None and cat not in AMBIGUOUS and EXCLUDE.search(cat):
        return None
    # 曖昧な種類は、名前の終わりで決められるときだけ。
    for suffixes, c in WIDE_BY_SUFFIX:
        if name.endswith(suffixes):
            return c
    for suffix, c in SUFFIX_CATEGORY:
        if name.endswith(suffix):
            return c
    return None


def spot_id(pref, name):
    h = hashlib.sha1(f"ov:{pref}/{name}".encode("utf-8")).hexdigest()[:10]
    return f"ov-{h}"


def load_candidates(wanted):
    """Overture から、一覧の名前に一致する行を集めます。

    candidates[正規化した名前] = [{lat, lng, key, name, category0, ...}, ...]
    名前の正規化は Python 側で1度だけ行います（DuckDB に Python の関数を
    渡すには numpy が要り、依存が増えるためです）。
    """
    if not os.path.exists(OV):
        raise SystemExit(
            "Overture の日本の施設がありません。先に\n"
            "  python3 tools/fetch_overture_places.py\n"
            "を走らせてください。")
    con = duckdb.connect()
    rows = con.execute(
        f"SELECT id, name, name_ja, lat, lng, confidence, operating_status, "
        f"category, dataset, license FROM read_parquet('{OV}') "
        f"WHERE name IS NOT NULL").fetchall()
    found = collections.defaultdict(list)
    for oid, name, ja, lat, lng, conf, status, cat, dataset, lic in rows:
        if status in ("permanently_closed", "temporarily_closed", "closed"):
            continue          # 閉業と分かっているものは、入れない
        keys = {n(x) for x in (name, ja) if x}
        keys &= wanted
        if not keys:
            continue
        cand = {"lat": lat, "lng": lng, "key": oid, "name": name or ja,
                "name_ja": ja, "cat0": cat, "conf": conf or 0.0,
                "dataset": dataset, "license": lic}
        for k in keys:
            found[k].append(cand)
    return found


def display_name(cand, name):
    """表示する名前。一覧に当たったほう（日本語）を採り、空白を整えます。"""
    want = {n(v) for v in variants(name)}
    for x in (cand["name_ja"], cand["name"]):
        if x and n(x) in want:
            return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", x)).strip()
    x = cand["name_ja"] or cand["name"]
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", x)).strip()


def match(unplaced, found, locator):
    hits, why = [], collections.Counter()
    for pref, raw in unplaced:
        name = clean_name(raw)
        if not name:
            why["閉店・店・宿・体験・催し"] += 1
            continue
        cands = []
        for v in variants(name):
            for c in found.get(n(v), []):
                if c["conf"] < MIN_CONFIDENCE:
                    continue
                cat = category_of(c["cat0"], display_name(c, name))
                if cat is None:
                    continue
                cands.append({**c, "category": cat})
            if cands:
                break
        chosen, reason, mismatch = select(cands, pref, locator)
        if chosen is None:
            why["Overture に無い（行き先の種類で）" if reason == "候補が無い"
                else reason] += 1
            continue
        hits.append((pref, raw, {**chosen, "name": display_name(chosen, name),
                                 "mismatch": mismatch}))
    return hits, why


def resolve_shared(hits):
    return place_match.resolve_shared(
        hits, lambda c: {n(x) for x in (c["name"], c.get("name_ja")) if x},
        lambda raw: n(clean_name(raw) or ""))


def main(write):
    upath = os.path.join(RAW, "tourlist-unplaced.json")
    if not os.path.exists(upath):
        raise SystemExit(
            "座標が引けなかった名前の一覧がありません。先に\n"
            "  python3 tools/import_tourism_list.py 一覧.xlsx --write\n"
            "を走らせてください。")
    with open(upath, encoding="utf-8") as f:
        unplaced = json.load(f)

    wanted = set()
    for pref, raw in unplaced:
        name = clean_name(raw)
        if name:
            wanted.update(n(v) for v in variants(name))
    print(f"座標が引けなかった名前 {len(unplaced)}件")
    found = load_candidates(wanted)
    print(f"  名前が一致した Overture の行 {sum(len(v) for v in found.values())}件")

    with open(os.path.join(WEB, "kb", "regions.json"), encoding="utf-8") as f:
        regions_doc = json.load(f)
    locator = PrefectureLocator(regions_doc["regions"])

    hits, why = match(unplaced, found, locator)
    hits, shared = resolve_shared(hits)
    if shared:
        why["同じ場所に複数の名前が当たった（決められない／注だけ違う）"] += shared

    shards = load_shards()
    # 前回ここが入れたぶんは、数え直します（2回走らせても二重にならない）。
    existing = [s for doc in shards.values() for s in doc["spots"]
                if s.get("src") != SRC]
    grid = collections.defaultdict(list)
    for s in existing:
        grid[(round(s["lat"] / 0.05), round(s["lng"] / 0.05))].append(s)

    add, used = [], set()
    for pref, raw, c in hits:
        name = re.sub(r"\s*[（(][^）)]*[）)]\s*$", "", c["name"]).strip() or c["name"]
        if (looks_unusable(name, c["lat"], c["lng"])
                or name.endswith(NOT_A_DESTINATION) or LODGING.search(name)):
            why["行き先にならない名前"] += 1
            continue
        if c["key"] in used:
            why["同じ場所に2つの名前が当たった"] += 1
            continue
        gx, gy = round(c["lat"] / 0.05), round(c["lng"] / 0.05)
        near = [x for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for x in grid[(gx + dx, gy + dy)]]
        probe = {"name": name, "lat": c["lat"], "lng": c["lng"]}
        if any(same_place(probe, s, km(c["lat"], c["lng"], s["lat"], s["lng"]))
               for s in near):
            why["すでに収録にある"] += 1
            continue
        region = locator.region_near(c["lat"], c["lng"])
        if km(c["lat"], c["lng"], region["lat"], region["lng"]) > MAX_PLACE_KM:
            why["エリアから遠すぎて置けない"] += 1
            continue
        spot = {
            "id": spot_id(pref, name),
            "regionId": region["id"],
            "name": name,
            "category": c["category"],
            "lat": round(c["lat"], 5),
            "lng": round(c["lng"], 5),
            # 一覧は1つだけです。定番かどうかを決める材料がありません。
            "fame_tier": "hidden",
            "overture": c["key"],
            "src": SRC,
            # 出どころとライセンス（CDLA Permissive 2.0 / Apache 2.0 / CC0）。
            "license": c["license"],
        }
        if c.get("mismatch"):
            spot["listedIn"] = pref
        add.append(spot)
        used.add(c["key"])
        grid[(gx, gy)].append(spot)

    why["足す"] = len(add)
    why["  うち県の食い違い"] = sum(1 for x in add if x.get("listedIn"))
    print("\n内訳:")
    for k, v in why.most_common():
        print(f"  {k}: {v}件")
    print()
    for cat, cnt in collections.Counter(s["category"] for s in add).most_common():
        print(f"  {cat} {cnt}件")

    if "--show" in sys.argv:
        import random
        random.seed(int(os.environ.get("SEED", "3")))
        catf = os.environ.get("CAT")
        pool = [(p, r, c) for p, r, c in hits if not catf or c["category"] == catf]
        print(f"\n無作為に30件{'（' + catf + '）' if catf else ''}"
              "（一覧の名前 → Overture の名前 / 分類 / 種類 / 信頼度 / 出どころ）:")
        for p, r, c in random.sample(pool, min(30, len(pool))):
            print(f"  {p} {r!r} → {c['name']!r} [{c['category']}] "
                  f"{c['cat0']} {c['conf']:.2f} {c['dataset']}")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    # 前回のぶんを、収録ぜんぶから印（src）で取り除きます。
    removed = 0
    for p, doc in shards.items():
        keep = [x for x in doc["spots"] if x.get("src") != SRC]
        removed += len(doc["spots"]) - len(keep)
        if len(keep) != len(doc["spots"]):
            doc["spots"] = keep
            with open(p, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    for p in glob.glob(os.path.join(WEB, "kb", "spots-ov*.json")):
        os.remove(p)
        shards.pop(p, None)
    if removed:
        print(f"  前回のぶん {removed}件 を取り除きました")

    per_file = 2500
    for i in range(0, len(add), per_file):
        chunk = add[i:i + per_file]
        p = os.path.join(WEB, "kb", f"spots-ov{i // per_file:02d}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"spots": chunk}, f, ensure_ascii=False,
                      separators=(",", ":"))
        shards[p] = {"spots": chunk}

    # **索引に登録します。** 登録しないと reshard_kb.py が読まずに消します。
    total = register(shards, regions_doc, [OVERTURE_SOURCE, PREF_SOURCE])
    print(f"\n収録 {total}件になりました。")
    print("このあと tools/reshard_kb.py を走らせて、県ごとに並べ直します。")


if __name__ == "__main__":
    main("--write" in sys.argv)
