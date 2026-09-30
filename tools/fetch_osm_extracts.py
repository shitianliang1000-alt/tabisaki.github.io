# -*- coding: utf-8 -*-
"""OpenStreetMap の日本の地域ごとの配布ファイルを落とす。

    python3 tools/fetch_osm_extracts.py            8地域ぜんぶ
    python3 tools/fetch_osm_extracts.py kanto      1つだけ
    python3 tools/fetch_osm_extracts.py --list     名前を出す

配布元は Geofabrik です（OpenStreetMap の日本の抽出データを毎日作って
います）。日本全体は約2GBありますが、8つの地域に分かれているので、
**地域ごとに落として、地域ごとに読みます**。全体を一度に読むと、
場所の索引だけで数GBの記憶が要ります。

データは ODbL 1.0 です。**「© OpenStreetMap contributors」の表示が
必須**で、この道具が入れた座標を含む収録は、同じ条件で共有する義務が
あります（tools/import_osm_tourlist.py の冒頭に書きました）。

落としたファイルは data/osm/ に置きます（.gitignore 済み。数GBあり、
落とし直せば同じものが手に入ります）。
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OUT = os.path.join(WEB, "data", "osm")

BASE = "https://download.geofabrik.de/asia/japan"
REGIONS = ["hokkaido", "tohoku", "kanto", "chubu", "kinki", "chugoku",
           "shikoku", "kyushu"]
UA = ("tabisaki-kb/1.0 (https://github.com/shitianliang1000-alt/"
      "tabisaki.github.io; kb build)")


def fetch(region):
    name = f"{region}-latest.osm.pbf"
    path = os.path.join(OUT, name)
    if os.path.exists(path):
        print(f"  {name} は、もうあります")
        return True
    os.makedirs(OUT, exist_ok=True)
    tmp = path + ".part"
    print(f"  {name} を落とします…")
    r = subprocess.run(
        ["curl", "-sS", "-f", "-L", "-m", "7200", "-A", UA,
         "-o", tmp, f"{BASE}/{name}"])
    if r.returncode != 0 or not os.path.exists(tmp):
        # **途中で切れたものを残しません。** 半分のファイルを残すと、
        # 次に「もうある」と見なして読み、地域の半分しか照合されません。
        if os.path.exists(tmp):
            os.remove(tmp)
        print(f"  {name} を落とせませんでした（curl の終了コード "
              f"{r.returncode}）。")
        return False
    os.replace(tmp, path)
    return True


def main(argv):
    if "--list" in argv:
        print("\n".join(REGIONS))
        return 0
    want = [a for a in argv if not a.startswith("--")] or REGIONS
    unknown = [w for w in want if w not in REGIONS]
    if unknown:
        raise SystemExit(f"知らない地域です: {' '.join(unknown)}")
    failed = [r for r in want if not fetch(r)]
    if failed:
        print(f"\n落とせなかった地域: {' '.join(failed)}\n"
              "  接続が切れる場合は、この環境から download.geofabrik.de へ\n"
              "  届いていません（ネットワークの許可を確かめてください）。")
        return 1
    print("\nそろいました。次は python3 tools/import_osm_tourlist.py --check")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
