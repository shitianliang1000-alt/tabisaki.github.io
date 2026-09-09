#!/usr/bin/env python3
# 行き先にならないものを、知識ベースから外す。
#
# なぜ要るか
# ----------
# 外部データには「観光資源」として載っていても、**その日に行っても
# 何も無い**ものが混ざります。
#
#   立山のライチョウ        … 鳥です。いつ行けば見られるのか誰にも言えません
#   松尾祭                  … 特定の日の行事。ほかの日に行っても何もありません
#   長岡まつり大花火大会    … 同上
#   一色カタクリ群生地      … 花の時期以外はただの林です
#   カモシカと森の体験館(休館中) … 閉まっています
#
# これらが旅程に入ると、「そこへ行っても何も無い」旅になります。
# 件数は減りますが、提案の質は上がります。
#
# 消さないもの
# ------------
#   函館朝市・日曜市      … 毎日（あるいは毎週）そこにある場所
#   祇園祭山鉾町          … 行事ではなく、町のこと
#   旧開智学校            … 「学校」という字が入るだけの重要文化財
#
# 名前だけでは決められないので、**残す語**を先に見ます。
#
#   python3 tools/clean_kb.py --dry-run
#   python3 tools/clean_kb.py

import argparse
import json
import os
import math
import re
import sys
import unicodedata

# --- 残すもの（先に判定します） ---------------------------------------------
# 「まつり」を含んでいても、場所として成り立つもの。
KEEP_WORDS = (
    "朝市", "市場", "日曜市", "常設", "資料館", "記念館", "博物館", "美術館",
    "旧開智", "会館", "ミュージアム", "祭り会館", "まつり会館",
    "山鉾町", "屋台会館", "の里", "公園", "神社", "寺",
)

# --- 外すもの ---------------------------------------------------------------

# 1. 特定の日にしかない催し。ほかの日に行っても何もありません。
EVENT = re.compile(
    r"(まつり|祭り|祭$|祭\(|例大祭|神事|花火大会|大煙火|大会$|フェスティバル|"
    r"フェスタ|イベント|ページェント|燈籠流し|灯籠流し|供養|法要|"
    r"行事$|踊り$|山焼き|裸祭|節分会|初詣|カウントダウン)")

# 2. 生き物・植物そのもの。場所ではありません。
LIVING = re.compile(
    r"(ライチョウ|雷鳥|タンチョウ|オジロワシ|オオワシ|カモシカ|ニホンザル|"
    r"ホタル(?!の里|館|ミュージアム)|蛍(?!街道)|"
    r"群生地|自生地|生息地|渡来地|繁殖地|群落|植物群落)")

# 3. いま行けないもの。
CLOSED = re.compile(r"(休館中|閉館|閉鎖|廃止|中止|移転)")

# 4. 行き先として意味を持たない設備。
FACILITY = re.compile(
    r"(給食センター|クリーンセンター|浄化センター|し尿|火葬|斎場|"
    r"下水|変電所|車庫|営業所|支所$|出張所$|保健所|保健センター)")

# 分類で外すもの。
DROP_CATEGORY = {"年中行事"}


def reason_to_drop(spot):
    name = spot.get("name", "")
    if any(w in name for w in KEEP_WORDS):
        return None
    if spot.get("category") in DROP_CATEGORY:
        return "年中行事"
    if CLOSED.search(name):
        return "いま行けない"
    if LIVING.search(name):
        return "生き物・群落"
    if EVENT.search(name):
        return "特定の日の催し"
    if FACILITY.search(name):
        return "行き先にならない設備"
    return None


# --- 重複 -------------------------------------------------------------------

def norm_key(name):
    """表記ゆれを吸収した見出し。

    「高徳院（鎌倉大仏）」と「高徳院(鎌倉大仏殿)」は同じ場所です。
    全角と半角の括弧を揃えていなかったので、別物として2件残っていました。
    指定した場所が旅程に入らない、という不具合の原因にもなります
    （片方を「必ず行く」に選ぶと、もう片方のあるエリアが選ばれる）。
    """
    k = unicodedata.normalize("NFKC", name)
    k = re.sub(r"[\s　・（）()「」『』\-－ー〜~,、。．.]", "", k)
    k = re.sub(r"(都|道|府|県|市|区|町|村)立", "", k)
    k = re.sub(r"(殿|跡|前|口)$", "", k)
    return k


def km(a, b):
    R = 6371.0
    p1 = math.radians(a.get("lat", 0.0))
    p2 = math.radians(b.get("lat", 0.0))
    dp = p2 - p1
    dl = math.radians(b.get("lng", 0.0) - a.get("lng", 0.0))
    h = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


SAME_PLACE_KM = 5.0
# 確認済みの収録を優先して残します。
PRIORITY = {"estimated": 1, "ai": 2}


def drop_duplicates(shards):
    """近くにある同じ場所を、1件に寄せます。

    名前が同じでも離れていれば別の場所です（白浜海水浴場は各地にある）。
    見出しと距離の両方で見ます。
    """
    seen = {}
    order = []
    for sh, path, doc, spots in shards:
        for s in spots:
            order.append(s)
    # 確認済み → 推定 → AI の順に見て、先に見たものを残します。
    order.sort(key=lambda s: PRIORITY.get(s.get("source"), 0))
    keep_ids = set()
    dupes = []
    for s in order:
        k = norm_key(s.get("name", ""))
        hit = None
        for other in seen.get(k, []):
            if km(other, s) < SAME_PLACE_KM:
                hit = other
                break
        if hit:
            dupes.append((s.get("name"), hit.get("name")))
            continue
        seen.setdefault(k, []).append(s)
        keep_ids.add(s.get("id"))
    return keep_ids, dupes


def load(kb_dir):
    index = json.load(open(os.path.join(kb_dir, "index.json"), encoding="utf-8"))
    shards = []
    for sh in index["shards"]:
        path = os.path.join(kb_dir, sh["file"])
        doc = json.load(open(path, encoding="utf-8"))
        spots = doc if isinstance(doc, list) else doc.get("spots", [])
        shards.append((sh, path, doc, spots))
    return index, shards


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kb", default="kb")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    index, shards = load(args.kb)
    total = sum(len(s[3]) for s in shards)
    sys.stderr.write("いまの収録: %d件\n" % total)

    by_reason = {}
    removed_names = []
    kept_total = 0
    for sh, path, doc, spots in shards:
        keep = []
        for s in spots:
            why = reason_to_drop(s)
            if why:
                by_reason[why] = by_reason.get(why, 0) + 1
                if len(removed_names) < 40:
                    removed_names.append(f"{s['name']}（{why}）")
                continue
            keep.append(s)
        kept_total += len(keep)
        sh["_keep"] = keep
        sh["_doc"] = doc
        sh["_path"] = path

    # 近くにある同じ場所を、1件に寄せます。
    remaining = [(sh, sh["_path"], sh["_doc"], sh["_keep"])
                 for sh in index["shards"]]
    keep_ids, dupes = drop_duplicates(remaining)
    dup_n = 0
    for sh in index["shards"]:
        before = len(sh["_keep"])
        sh["_keep"] = [s for s in sh["_keep"] if s.get("id") in keep_ids]
        dup_n += before - len(sh["_keep"])
    kept_total -= dup_n
    if dup_n:
        by_reason["同じ場所が2件"] = dup_n

    sys.stderr.write("外すもの: %d件\n" % (total - kept_total))
    for why, n in sorted(by_reason.items(), key=lambda x: -x[1]):
        sys.stderr.write("  %-16s %d件\n" % (why, n))
    sys.stderr.write("残る: %d件\n" % kept_total)

    if args.dry_run:
        sys.stderr.write("\n外れるものの例:\n")
        for n in removed_names[:20]:
            sys.stderr.write("  %s\n" % n)
        if dupes:
            sys.stderr.write("\n同じ場所とみなしたもの:\n")
            for a, b in dupes[:15]:
                sys.stderr.write("  %s ← %s\n" % (b, a))
        sys.stderr.write("\n--dry-run なので書き込みません。\n")
        return

    for sh in index["shards"]:
        keep = sh.pop("_keep")
        doc = sh.pop("_doc")
        path = sh.pop("_path")
        if isinstance(doc, list):
            out = keep
        else:
            doc["spots"] = keep
            out = doc
        json.dump(out, open(path, "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
        sh["count"] = len(keep)
    index["counts"]["spots"] = kept_total
    json.dump(index, open(os.path.join(args.kb, "index.json"), "w",
                          encoding="utf-8"), ensure_ascii=False)
    sys.stderr.write("書き込みました。\n")


if __name__ == "__main__":
    main()
