# -*- coding: utf-8 -*-
"""エリアの拠点を、実在する駅にする。

kb/regions.json の 1,370エリアのうち **1,323件** は、拠点の名前が
「千代田区中心部」「京都市中心部」でした。座標はエリアの代表点、名前は
自動で付けたものです。これが、画面の3つの不満の正体でした。

    東京駅発なのに   1日目 8:00 東京駅 → 千代田区中心部（0.8km）
    無駄な移動       そのあと 8:15 貨幣博物館へ移動（1.2km・東京駅の隣）
    時間が出ない     Yahoo!は「千代田区中心部」を解決できません → 推定

拠点は、**実際に列車の止まる駅**でなければ意味がありません。旅程では
そこが「その街に着く場所」であり、乗換案内に渡す名前でもあるからです。

置き換えかたは2段です。

  1. **エリアの名前と同じ駅**があれば、それにします（京都市→京都駅、
     熱海市→熱海駅）。旅行者が「その街の駅」と言われて思い浮かべるのは
     これで、特急も止まります。
  2. 無ければ、**そのエリアの立ち寄り先に近い駅**にします。市域の
     代表点ではありません。合併した市の代表点は山の中にあることが多く、
     そこに近い駅（浜松市→気賀駅、6.4km）を拠点にすると、旅程の
     移動時間が最初から狂います。

どちらも遠すぎるときは、置き換えません。

    python3 tools/region_stations.py --check   確認するだけ
    python3 tools/region_stations.py --write   置き換えて書き戻す
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

# これより遠い駅は、そのエリアの拠点とは呼べません。
MAX_KM = 12.0
# 名前が一致する駅は、少し遠くても採ります（市域が広いためです）。
NAME_MAX_KM = 30.0

CELL = 0.1


def km(a_lat, a_lng, b_lat, b_lng):
    dy = (a_lat - b_lat) * 111.0
    dx = (a_lng - b_lng) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    return math.hypot(dx, dy)


def load_stops():
    with open(os.path.join(WEB, "kb", "stops-rail.json"), encoding="utf-8") as f:
        stops = json.load(f)["stops"]
    grid = {}
    by_name = {}
    for lat, lng, name in stops:
        grid.setdefault((round(lat / CELL), round(lng / CELL)), []).append(
            (lat, lng, name))
        by_name.setdefault(name, []).append((lat, lng, name))
    return grid, by_name


def bare(name):
    """「京都市」→「京都」。駅名と突き合わせるための形。"""
    for suffix in ("市", "区", "町", "村", "郡"):
        if name.endswith(suffix) and len(name) > 2:
            return name[:-1]
    return name


def spot_centers():
    """エリアごとの、立ち寄り先の重心。無ければ None。"""
    import glob
    acc = {}
    for path in glob.glob(os.path.join(WEB, "kb", "spots-*.json")):
        with open(path, encoding="utf-8") as f:
            for s in json.load(f)["spots"]:
                a = acc.setdefault(s["regionId"], [0.0, 0.0, 0])
                a[0] += s["lat"]
                a[1] += s["lng"]
                a[2] += 1
    return {k: (v[0] / v[2], v[1] / v[2]) for k, v in acc.items() if v[2]}


def nearest(grid, lat, lng, max_km=MAX_KM):
    best, best_km = None, max_km
    reach = int(max_km / (CELL * 111)) + 1
    cx, cy = round(lat / CELL), round(lng / CELL)
    for dx in range(-reach, reach + 1):
        for dy in range(-reach, reach + 1):
            for s in grid.get((cx + dx, cy + dy), ()):
                d = km(lat, lng, s[0], s[1])
                if d < best_km:
                    best, best_km = s, d
    return best, best_km


def main(write):
    path = os.path.join(WEB, "kb", "regions.json")
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    grid, by_name = load_stops()
    centers = spot_centers()

    fixed, kept, far = [], 0, []
    for r in doc["regions"]:
        name = r.get("station") or ""
        # すでに実在の駅が入っているエリア（箱根湯本駅など）は触りません。
        if name and "中心部" not in name:
            kept += 1
            continue
        # 立ち寄り先の重心。旅程で実際に動きまわるのはこの辺りです。
        cy, cx = centers.get(r["id"], (r["lat"], r["lng"]))

        # 1. エリアの名前と同じ駅
        stop, d = None, None
        for cand in by_name.get(bare(r["name"]), ()):
            dd = km(cy, cx, cand[0], cand[1])
            if dd <= NAME_MAX_KM and (d is None or dd < d):
                stop, d = cand, dd
        # 2. 立ち寄り先に近い駅
        if not stop:
            stop, d = nearest(grid, cy, cx)
        if not stop:
            far.append(r)
            continue
        fixed.append((r, stop, d))

    print(f"実在の駅がすでに入っている {kept}件")
    print(f"置き換える {len(fixed)}件 / 近くに駅が無い {len(far)}件")
    for r, stop, d in fixed[:8]:
        print(f"  {r['name']}: {r.get('station')} → {stop[2]}駅"
              f"（{d:.1f}km）")
    for r in far[:8]:
        print(f"  駅なし: {r['name']}")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    # 駅の無いエリアは、拠点の座標をエリアの代表点に合わせておきます。
    # 屋久島町の「拠点」は、島から38km離れた海の上にありました。
    for r in far:
        r["stationLat"] = round(r["lat"], 5)
        r["stationLng"] = round(r["lng"], 5)

    for r, stop, _ in fixed:
        # 収録の停留所は駅名に「駅」が付いていません（「新宿」）。
        # 乗換案内にも画面にも、駅として通る形で渡します。
        r["station"] = stop[2] if stop[2].endswith("駅") else f"{stop[2]}駅"
        r["stationLat"] = round(stop[0], 5)
        r["stationLng"] = round(stop[1], 5)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"\n{len(fixed)}件のエリアの拠点を、実在の駅にしました。")


if __name__ == "__main__":
    main(write="--write" in sys.argv)
