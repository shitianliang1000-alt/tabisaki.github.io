# -*- coding: utf-8 -*-
"""OpenStreetMap の日本の配布ファイルを落とす。

    python3 tools/fetch_osm_extracts.py            日本全体（OSM France）
    python3 tools/fetch_osm_extracts.py --geofabrik   地域ごと8本（Geofabrik）

## 入手先

**既定は OSM France です**（日本全体で1本、約2.7GB、毎日更新）。

はじめは Geofabrik の地域ごとの配布を使うつもりでした。ところが
download.geofabrik.de は、この環境から**接続が開いた直後に切られます**
（7秒で切れて、受信は「接続確立」の応答だけです）。ネットワーク設定の
問題ではありませんでした（openstreetmap.org や example.org は通ります）。
特定のサイトが、この出口からの接続を切っているようです。

同じ OpenStreetMap のデータを配っている入手先なので、OSM France を
既定にしました。Geofabrik に届く環境では、--geofabrik で地域ごとに
落とせます（記憶が少なく済みます）。

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

FRANCE = "https://download.openstreetmap.fr/extracts/asia/japan.osm.pbf"
BASE = "https://download.geofabrik.de/asia/japan"
REGIONS = ["hokkaido", "tohoku", "kanto", "chubu", "kinki", "chugoku",
           "shikoku", "kyushu"]
UA = ("tabisaki-kb/1.0 (https://github.com/shitianliang1000-alt/"
      "tabisaki.github.io; kb build)")


def download(name, url):
    path = os.path.join(OUT, name)
    if os.path.exists(path):
        print(f"  {name} は、もうあります")
        return True
    os.makedirs(OUT, exist_ok=True)
    tmp = path + ".part"
    print(f"  {name} を落とします…")
    r = subprocess.run(
        ["curl", "-sS", "-f", "-L", "-m", "7200", "-A", UA,
         "-o", tmp, url])
    if r.returncode != 0 or not os.path.exists(tmp):
        # **途中で切れたものを残しません。** 半分のファイルを残すと、
        # 次に「もうある」と見なして読み、半分しか照合されません。
        if os.path.exists(tmp):
            os.remove(tmp)
        print(f"  {name} を落とせませんでした（curl の終了コード "
              f"{r.returncode}）。")
        return False
    os.replace(tmp, path)
    return True


def main(argv):
    if "--list" in argv:
        print("japan（OSM France）\n" + "\n".join(REGIONS))
        return 0
    if "--geofabrik" in argv:
        want = [a for a in argv if not a.startswith("--")] or REGIONS
        unknown = [w for w in want if w not in REGIONS]
        if unknown:
            raise SystemExit(f"知らない地域です: {' '.join(unknown)}")
        failed = [r for r in want if not download(
            f"{r}-latest.osm.pbf", f"{BASE}/{r}-latest.osm.pbf")]
    else:
        failed = [] if download("japan.osm.pbf", FRANCE) else ["japan"]
    if failed:
        print(f"\n落とせなかったもの: {' '.join(failed)}\n"
              "  接続が切れる場合は、その入手先が、この環境からの接続を\n"
              "  切っています（設定ではなく、相手側のことがあります）。")
        return 1
    print("\nそろいました。次は python3 tools/import_osm_tourlist.py --check")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
