# -*- coding: utf-8 -*-
"""催しを収録から外す。

国土数値情報の観光資源（P12）には、**場所ではなく催し**が混ざって
います。旅程に「花火物語」「赤穂シティマラソン」が並んでいました。

    3日目 13:28  花火物語（穴場）
                 09:00〜17:00・最終入場 16:45

花火大会に開館時間はありません。開催は年に1日で、その日以外は何も
ありません。行っても、何もない河川敷に立つことになります。

外すのは**名前そのものが催し**のものだけです。括弧の中に催しが書いて
あるだけの場所（「大和神社(初詣を含む)」「西寒多神社(藤まつり)」）は
神社そのものなので残します。

    python3 tools/drop_events.py --check   確認するだけ
    python3 tools/drop_events.py --write   外して書き戻す
"""
import collections
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

# 名前に入っていたら催しと見なす語。
#
# 「市」は入れていません。朝市・夕市は開く日が決まっていますが、
# 場所としては実在し、市場としてそこにあります。線を引くなら
# 「その日以外は何も無い」ところです。
EVENT = re.compile(
    r"花火|まつり|祭り|マラソン|駅伝|大会|公演|フェスティバル|フェスタ"
    r"|イルミネーション|ライトアップ|初詣|節分|カーニバル|コンサート"
    r"|ページェント|七夕|盆踊り|どんど焼き|灯籠流し|万灯|大文字")

PAREN = re.compile(r"[（(][^）)]*[）)]")

# 建物の名前で終わるものは、催しではなく場所です。
#
# 「浜松まつり会館」は、まつりの道具を展示している博物館です。年に一度
# ではなく、いつでも開いています。語だけで切ると、これも消えます。
PLACE_TAIL = re.compile(
    r"(会館|館|センター|ミュージアム|資料室|神社|寺|城|駅|公園|広場|温泉"
    r"|ホール|劇場|屋敷|学校|工房|市場|展望台|山|滝|峠|岬|浜|海岸|島|湖"
    r"|池|川|橋|門|塔|園|苑|荘|渓谷|牧場|農園|庭園)$")


def is_event(name):
    """名前そのものが催しか。括弧の中だけなら、場所のほうを採ります。"""
    base = PAREN.sub("", name).strip()
    if PLACE_TAIL.search(base):
        return False
    return bool(EVENT.search(base))


def load_shards():
    out = {}
    for path in sorted(glob.glob(os.path.join(WEB, "kb", "spots-*.json"))):
        with open(path, encoding="utf-8") as f:
            out[path] = json.load(f)
    return out


def main(write):
    shards = load_shards()
    drops = []
    for doc in shards.values():
        for s in doc["spots"]:
            if is_event(s["name"]):
                drops.append(s)

    by_cat = collections.Counter(s["category"] for s in drops)
    total = sum(len(d["spots"]) for d in shards.values())
    print(f"収録 {total}件 のうち、催しは {len(drops)}件")
    for cat, n in by_cat.most_common(8):
        print(f"  {cat} {n}件")
    for s in drops[:10]:
        print(f"  外す: {s['name']}")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    ids = {s["id"] for s in drops}
    for path, doc in shards.items():
        doc["spots"] = [s for s in doc["spots"] if s["id"] not in ids]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))

    # 件数は kb/index.json と kb/regions.json にも書いてあります。
    left = sum(len(d["spots"]) for d in shards.values())
    per_region = collections.Counter(
        s["regionId"] for d in shards.values() for s in d["spots"])
    rpath = os.path.join(WEB, "kb", "regions.json")
    with open(rpath, encoding="utf-8") as f:
        regions = json.load(f)
    for reg in regions["regions"]:
        if "spotCount" in reg:
            reg["spotCount"] = per_region.get(reg["id"], 0)
    with open(rpath, "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, separators=(",", ":"))

    ipath = os.path.join(WEB, "kb", "index.json")
    with open(ipath, encoding="utf-8") as f:
        index = json.load(f)
    counts = {os.path.basename(p): len(d["spots"]) for p, d in shards.items()}
    for shard in index.get("shards", []):
        if shard["file"] in counts:
            shard["count"] = counts[shard["file"]]
    if "counts" in index:
        index["counts"]["spots"] = left
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n収録 {left}件になりました。")


if __name__ == "__main__":
    main(write="--write" in sys.argv)
