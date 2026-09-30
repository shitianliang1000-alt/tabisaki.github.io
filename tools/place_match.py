# -*- coding: utf-8 -*-
"""一覧の名前に、座標の候補から1つを決める。（ウィキペディア・OSM・Overture 共通）

    from place_match import select, resolve_shared

座標の出どころは3つあります（tools/import_tourism_list.py＝ウィキペディア、
tools/import_osm_tourlist.py＝OpenStreetMap、tools/import_overture_places.py＝
Overture Maps）。**どれも「同じ名前の候補が複数ある中から、どれか1つに
決める」という同じ問題**を持っています。3か所に同じ規則を書くと食い違う
ので、ここに1つだけ書きます。

## 決め方

1. **県が合う候補**を見る（座標が、一覧の県のエリアの近くにあるもの）
     ・800m以内は同じ場所と見なして、1つに数える
     ・1か所に決まれば、それを採る
     ・**離れた2か所以上あれば、決めない**（同じ県の中の同名。どちらか
       分からない）
2. **県が合う候補が無いとき**（ご指示で、県の食い違いを許します）
     ・全国で1か所に決まれば、それを採る
     ・全国で2か所以上なら、**一覧の県にいちばん近い場所**を採る。ただし
       その県のエリアから NEAR_PREF_KM 以内のときだけ（県境の山などは
       近くにあります。遠いものは、別の場所である可能性が高いです）

県の食い違いで採ったものには、mismatch=True を付けます（あとから数えたり、
外したりできるようにするため）。

## 県の食い違いを許してよい理由

入る物は、**名前と座標が同じ出どころの1件から来ています**。実在する場所
で、表示する県もその座標から決まります（一覧の県ではなく）。一覧が指して
いた場所とは別の同名の場所かもしれませんが、それ自体が行き先として間違い
ではありません。

一方で、「島根県の熊谷家住宅」を探して、山口県の熊谷家住宅を採ることは
あり得ます。そのため mismatch の印と、数の報告を残します。
"""
import collections
import math
import re

# 同じ場所と見なす距離。これ以内の候補は1つに数えます。
CLUSTER_KM = 0.8

# 県が合う候補が無いとき、一覧の県のエリアからこの距離以内の場所だけを採る
# （全国に同名が複数あって、どれか決められないとき）。
NEAR_PREF_KM = 100.0


def km(a_lat, a_lng, b_lat, b_lng):
    dy = (a_lat - b_lat) * 111.0
    dx = (a_lng - b_lng) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    return math.hypot(dx, dy)


def cluster(cands):
    """800m 以内の候補を1つの場所にまとめます。"""
    groups = []
    for c in cands:
        for g in groups:
            if km(c["lat"], c["lng"], g[0]["lat"], g[0]["lng"]) <= CLUSTER_KM:
                g.append(c)
                break
        else:
            groups.append([c])
    return groups


def pick(group):
    """同じ場所の候補のうち、どれを採るか。

    **走らせるたびに変わらない**ように決めます。点（node）を面（way）より
    先にします（面の重心より、点のほうが「ここ」と指している場合が多い
    ため）。それでも決まらなければ、番号の若いほうです。

    候補には "key" を持たせてください（OSM は "node/123"、Overture は
    その id）。
    """
    def order(c):
        key = str(c.get("key", ""))
        return (key.startswith("way"), key)
    return sorted(group, key=order)[0]


def select(cands, pref, locator, near_pref_km=NEAR_PREF_KM):
    """候補の中から、一覧の県（pref）に合わせて1つに決めます。

    返り値: (採った候補 or None, 理由, mismatch)

    理由（採らないとき）:
      "候補が無い"                      名前の候補が1つも無い
      "県が合わず、決められない"          全国で複数、かつ県から遠い
      "同じ県に同名が複数（決められない）"  県の中に離れた同名が2か所以上
    """
    if not cands:
        return None, "候補が無い", False

    inpref = [c for c in cands
              if locator.in_prefecture(c["lat"], c["lng"], pref)[0]]
    if inpref:
        groups = cluster(inpref)
        if len(groups) > 1:
            return None, "同じ県に同名が複数（決められない）", False
        return pick(groups[0]), "", False

    # 県が合う候補が無い。ご指示で、県の食い違いを許します。
    groups = cluster(cands)
    if len(groups) == 1:
        return pick(groups[0]), "", True
    # 全国で複数。一覧の県にいちばん近いもの（近いときだけ）。
    scored = []
    for g in groups:
        c = pick(g)
        scored.append((locator.dist_to_prefecture(c["lat"], c["lng"], pref), c))
    scored.sort(key=lambda x: (x[0], str(x[1].get("key", ""))))
    best_d, best = scored[0]
    if best_d <= near_pref_km:
        return best, "", True
    return None, "県が合わず、決められない", False


def resolve_shared(hits, names_of, clean, key="key"):
    """同じ候補に、一覧の名前が複数当たったときの決め方。

    実物で見つかりました。栃木県の一覧には、**別々の場所の**「城山公園」が
    2つ載っています。

        城山公園（祇園城跡）
        城山公園（佐野城跡）

    括弧の注を外して比べるので、どちらも OSM の1つの「城山公園」に当たります。
    **片方は必ず誤り**で、どちらかは分かりません。

    一方、注が季節や花のときは、同じ場所です。

        渋川市総合公園
        渋川市総合公園（アジサイ）

    括弧の注が場所なのか花なのかは、名前からは分かりません。決め方は、
    一覧の名前（括弧つき）が候補の名前に**そのまま一致するか**です。

      ・そのまま一致するものがある     → それだけを採る（注だけ違うものは外す）
      ・どれも括弧を外さないと一致しない
          名前の本体が同じ              → **決められないので、全部外す**
          名前の本体が違う（別名どうし）  → 同じ場所の別名なので、最初を採る

    hits は [(pref, raw, cand), ...]。names_of(cand) は候補が持つ名前の並び、
    clean(raw) は一覧の名前の整形（None なら外す）。n は呼ぶ側で正規化済みの
    形を返すこと。
    返り値: (残すもの, 外した数)
    """
    groups = collections.defaultdict(list)
    for h in hits:
        groups[h[2][key]].append(h)
    keep, dropped = [], 0
    for _, hs in groups.items():
        if len(hs) == 1:
            keep.append(hs[0])
            continue
        cand_names = set(names_of(hs[0][2]))
        exact = [h for h in hs if (clean(h[1]) or "") in cand_names]
        if exact:
            keep.append(exact[0])
            dropped += len(hs) - 1
            continue
        bare = {re.sub(r"[（(][^）)]*[）)]", "", clean(h[1]) or "") for h in hs}
        if len(bare) == 1:
            dropped += len(hs)          # 同じ名前の別の場所かもしれない
        else:
            keep.append(hs[0])
            dropped += len(hs) - 1
    order = {id(h): i for i, h in enumerate(hits)}
    keep.sort(key=lambda h: order[id(h)])       # 走らせるたびに同じ並び
    return keep, dropped


def select_for(cands, pref, locator, weak):
    """select に、「弱い名前の一致は県が合うときだけ」を足したもの。

    弱い名前（括弧の中の別名・「」の中・空白で割った切れ端。
    tools/import_tourism_list.py の split_variants）は、別の場所に当たり
    やすいので、県の食い違いを許しません。
    """
    if weak:
        cands = [c for c in cands
                 if locator.in_prefecture(c["lat"], c["lng"], pref)[0]]
    return select(cands, pref, locator)
