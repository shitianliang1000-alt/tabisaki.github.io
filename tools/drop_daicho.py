# -*- coding: utf-8 -*-
"""観光資源台帳（日本観光振興協会）由来のデータを収録から外す。

外す理由は、中身の良し悪しではありません。**再配布してよいかがはっきり
しない**ためです。このアプリの収録は公開リポジトリに入っているので、
条件の曖昧なものは置きません。

残すもの（いずれも国土交通省のオープンデータ）:

    src="kokudo"     国土数値情報 観光資源（P12）
    spots-p27.json   国土数値情報 文化施設（P27）
    src なし         このアプリで手作業で確認したもの

外すもの:

    src="daicho"     観光資源台帳

  ※ 収録ファイル名の "p27" は国土数値情報のP27（文化施設）です。
    観光資源台帳とは別の出典なので、混同して消さないでください。

外すと、次の後始末が要ります。手で1つずつ直すと、件数の表示だけが
古いまま残ります。

  ・名寄せで台帳側を残し、国土数値情報側を消した組があります。
    台帳を外すと、その場所ごと消えてしまうので、消したほうを戻します。
  ・スポットが0件になるエリアは、行き先の候補から外します
    （候補に出ても、その土地には何も出せません）。
  ・件数は kb/index.json と kb/regions.json にも書いてあります。

    python3 tools/drop_daicho.py --check   確認するだけ
    python3 tools/drop_daicho.py --write   外して書き戻す
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

DROP_SRC = "daicho"

# 名寄せ（tools/dedupe_spots.py）で台帳側を残し、こちらを消していたもの。
# 台帳を外すと場所ごと消えるので、書き戻します。
RESTORE = [
    {
        "id": "n0075-12", "regionId": "n0075", "name": "酸ヶ湯温泉",
        "category": "温泉", "lat": 40.65021, "lng": 140.85057,
        "fame_tier": "hidden", "src": "kokudo",
        "description": "荒川南荒川山国有林酸湯沢50",
    },
]


def load_shards():
    out = {}
    for path in sorted(glob.glob(os.path.join(WEB, "kb", "spots-*.json"))):
        with open(path, encoding="utf-8") as f:
            out[path] = json.load(f)
    return out


def main(write):
    shards = load_shards()
    have = {s["id"] for doc in shards.values() for s in doc["spots"]}

    drop = sum(1 for doc in shards.values()
               for s in doc["spots"] if s.get("src") == DROP_SRC)
    restore = [r for r in RESTORE if r["id"] not in have]
    print(f"観光資源台帳の収録: {drop}件")
    print(f"書き戻すもの: {len(restore)}件"
          + (f"（{'、'.join(r['name'] for r in restore)}）" if restore else ""))

    # 外したあとに残る件数を、エリアごとに数えます。
    per_region = {}
    for doc in shards.values():
        for s in doc["spots"]:
            if s.get("src") == DROP_SRC:
                continue
            per_region[s["regionId"]] = per_region.get(s["regionId"], 0) + 1
    for r in restore:
        per_region[r["regionId"]] = per_region.get(r["regionId"], 0) + 1

    rpath = os.path.join(WEB, "kb", "regions.json")
    with open(rpath, encoding="utf-8") as f:
        regions = json.load(f)
    empty = [r for r in regions["regions"] if per_region.get(r["id"], 0) == 0]
    print(f"スポットが0件になるエリア: {len(empty)}件")
    for r in empty:
        print(f"  {r['name']}（{r.get('prefecture', '')}）")

    total = sum(per_region.values())
    print(f"\n収録 {sum(len(d['spots']) for d in shards.values())}件"
          f" → {total}件 / エリア {len(regions['regions'])}件"
          f" → {len(regions['regions']) - len(empty)}件")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    for path, doc in shards.items():
        before = len(doc["spots"])
        doc["spots"] = [s for s in doc["spots"] if s.get("src") != DROP_SRC]
        if path.endswith("spots-00.json"):
            doc["spots"].extend(restore)
        if len(doc["spots"]) != before:
            print(f"{os.path.basename(path)}: {before} → {len(doc['spots'])}")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))

    empty_ids = {r["id"] for r in empty}
    regions["regions"] = [r for r in regions["regions"]
                          if r["id"] not in empty_ids]
    for r in regions["regions"]:
        if "spotCount" in r:
            r["spotCount"] = per_region.get(r["id"], 0)
    with open(rpath, "w", encoding="utf-8") as f:
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
        index["counts"]["regions"] = len(regions["regions"])
    # 使わなくなった出典は、出典表示からも外します。
    index["sources"] = [s for s in index.get("sources", [])
                        if "観光資源台帳" not in s.get("name", "")]
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n収録 {total}件 / エリア {len(regions['regions'])}件 になりました。")


if __name__ == "__main__":
    main(write="--write" in sys.argv)
