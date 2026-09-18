#!/usr/bin/env python3
# coding: utf-8
"""Wikidata 由来のスポットに、公式サイトと電話番号を付ける。

    python3 tools/enrich_wikidata.py [kb ディレクトリ] [--dry-run]

なぜ要るのか
------------
収録 29,706 件のうち、公式サイト（url）と電話（tel）を持つものは
**0 件**でした。旅程には Wikipedia と Google マップのリンクは付きますが、
「圏外で地図アプリが重いとき、電話を1本かけたい」「予約が要るか
公式で確かめたい」に答えられません。

収録の半分（14,878 件）は Wikidata から来ています（id が wd-Q…）。
Wikidata には公式サイト（P856）と電話番号（P1329）があります。
**あるものを取りに行くだけ**で、作り話ではありません。

やりかた
--------
・Q番号を 200 件ずつ VALUES にまとめて SPARQL に投げます（75 回ほど）。
・1 回ごとに 1.5 秒置きます（query.wikidata.org は 1 秒に数回で断られます）。
・取れた url / tel を、県ごとの段（kb/spots-jpNN-*.json）に書き戻します。
・**すでに url / tel を持つものは上書きしません。** 手で直したものが
  あれば、そちらが正です。
・複数の公式サイトがあるものは、最初の1つだけを採ります。

書き戻す形
----------
    {"id": "wd-Q3514126", ..., "url": "https://...", "tel": "+81-982-72-2413"}

電話は Wikidata の形（+81-…）のまま入れます。画面で日本の形（0982-…）に
直すのは js/links.js の仕事です（データは出どころのまま持ちます）。
"""

import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://query.wikidata.org/sparql"
UA = "tabisaki-enrich/1.0 (https://github.com/shitianliang1000-alt/tabisaki.github.io)"
BATCH = 200
PAUSE_SEC = 1.5


def sparql(qids):
    values = " ".join("wd:%s" % q for q in qids)
    query = (
        "SELECT ?item ?site ?tel WHERE { VALUES ?item { %s } "
        "OPTIONAL { ?item wdt:P856 ?site } OPTIONAL { ?item wdt:P1329 ?tel } }"
        % values)
    data = urllib.parse.urlencode({"query": query}).encode("utf-8")
    req = urllib.request.Request(ENDPOINT, data=data, headers={
        "Accept": "application/sparql-results+json",
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.loads(res.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - 断られたら待って、もう一度
            wait = 5 * (attempt + 1)
            sys.stderr.write("  retry in %ds (%s)\n" % (wait, e))
            time.sleep(wait)
    raise SystemExit("SPARQL に4回続けて断られました")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    kb_dir = args[0] if args else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "kb")
    files = sorted(f for f in os.listdir(kb_dir)
                   if f.startswith("spots-jp") and f.endswith(".json"))

    # まず、どの段にどの Q番号があるかを集めます。
    docs = {}
    want = []
    for f in files:
        with io.open(os.path.join(kb_dir, f), encoding="utf-8") as fh:
            doc = json.load(fh)
        docs[f] = doc
        for s in doc.get("spots", []):
            if not str(s.get("id", "")).startswith("wd-Q"):
                continue
            if s.get("url") and s.get("tel"):
                continue          # もう持っています
            want.append(s["id"][3:])
    want = sorted(set(want))
    sys.stderr.write("%d 件を Wikidata に聞きます（%d 回）\n"
                     % (len(want), (len(want) + BATCH - 1) // BATCH))

    found = {}
    for i in range(0, len(want), BATCH):
        chunk = want[i:i + BATCH]
        res = sparql(chunk)
        for b in res.get("results", {}).get("bindings", []):
            q = b["item"]["value"].rsplit("/", 1)[-1]
            row = found.setdefault(q, {})
            site = b.get("site", {}).get("value")
            tel = b.get("tel", {}).get("value")
            # 複数あるときは最初の1つ。https のものを先に。
            if site and (not row.get("url") or (site.startswith("https://")
                                                 and not row["url"].startswith("https://"))):
                row["url"] = site
            if tel and not row.get("tel"):
                row["tel"] = tel
        sys.stderr.write("  %d/%d  取れた: %d\n"
                         % (min(i + BATCH, len(want)), len(want), len(found)))
        time.sleep(PAUSE_SEC)

    # 書き戻します。すでにあるものは上書きしません。
    n_url = n_tel = 0
    for f, doc in docs.items():
        touched = False
        for s in doc.get("spots", []):
            sid = str(s.get("id", ""))
            if not sid.startswith("wd-Q"):
                continue
            row = found.get(sid[3:])
            if not row:
                continue
            if row.get("url") and not s.get("url"):
                s["url"] = row["url"]; n_url += 1; touched = True
            if row.get("tel") and not s.get("tel"):
                s["tel"] = row["tel"]; n_tel += 1; touched = True
        if touched and not dry:
            with io.open(os.path.join(kb_dir, f), "w", encoding="utf-8") as fh:
                fh.write(json.dumps(doc, ensure_ascii=False,
                                    separators=(",", ":")))
    sys.stderr.write("公式サイト %d 件・電話 %d 件を書き戻しました%s\n"
                     % (n_url, n_tel, "（試し。書いていません）" if dry else ""))


if __name__ == "__main__":
    main()
