# -*- coding: utf-8 -*-
"""ウィキペディアの配布ファイルから、一覧記事のリンク先を読む。

    python3 tools/wikipedia_links.py 日本の温泉地一覧 日本の山一覧 …

なぜ配布ファイルなのか（座標のときと同じ話です）
--------------------------------------------------
一覧記事のリンクは REST（api.wikimedia.org）から取れます。実際そうして
いました。1記事1回なので71回で済む——はずでした。

ところが2時間ほど回したところで、こちらも断られ始めました。

    429 … 15秒待ちます
    429 … 300秒待ちます
    429 … 600秒待ちます

71本のうち55本まで来て止まりました。**回数の問題ではありません。**
共用の出口から続けて叩いているぶんが、まとめて数えられています。

座標のときと同じことをします。配布ファイルなら、何本の一覧を読んでも
問い合わせは2回です。

    jawiki-latest-linktarget.sql.gz  134MB  番号 → リンク先の題
    jawiki-latest-pagelinks.sql.gz   763MB  記事の番号 → リンク先の番号

落とすのに3分、読むのに数分かかりますが、**相手に迷惑をかけません**し、
何度でもやり直せます。

REST から取ったぶんとの違い
----------------------------
pagelinks には、まだ書かれていない記事（赤リンク）も入っています。
REST の HTML からは `?action=edit&redlink=1` の形で見えていたものです。
どちらも座標表に当たらないので、落ちるところは同じです。

逆に pagelinks のほうが多く拾えます。テンプレート越しのリンクが
入るためです。一覧記事の表がテンプレートで書かれていると、REST の
HTML には出ても、それはそれで拾えていました——つまり結果はほぼ同じで、
**違うのは相手にかける負担だけ**です。
"""
import json
import os
import sys

from wikipedia_coords import DUMPS, download, fields, have, rows, unquote

LINKTARGET = "jawiki-latest-linktarget.sql.gz"
PAGELINKS = "jawiki-latest-pagelinks.sql.gz"
PAGE = "jawiki-latest-page.sql.gz"


def page_ids_of(titles):
    """記事名 → 記事の番号（標準名前空間だけ）。"""
    want = set(titles)
    out = {}
    for blob in rows(os.path.join(DUMPS, PAGE)):
        f = fields(blob)
        if len(f) < 3:
            continue
        try:
            page_id = int(f[0])
            ns = int(f[1])
        except ValueError:
            continue
        if ns != 0:
            continue
        name = unquote(f[2]).replace("_", " ")
        if name in want:
            out[name] = page_id
    return out


def target_titles(lt_ids):
    """リンク先の番号 → 題（標準名前空間だけ）。"""
    out = {}
    for blob in rows(os.path.join(DUMPS, LINKTARGET)):
        f = fields(blob)
        # lt_id, lt_namespace, lt_title
        if len(f) < 3:
            continue
        try:
            lt_id = int(f[0])
            ns = int(f[1])
        except ValueError:
            continue
        if ns != 0 or lt_id not in lt_ids:
            continue
        out[lt_id] = unquote(f[2]).replace("_", " ")
    return out


def links_from(page_ids):
    """記事の番号 → リンク先の題の並び。

    pagelinks は日本語版で3億行あります。**まるごと持ちません。**
    聞かれた記事から出ている線だけを拾い、そのぶんの番号を覚えます。
    """
    want = set(page_ids)
    edges = {pid: [] for pid in want}
    seen = set()
    for blob in rows(os.path.join(DUMPS, PAGELINKS)):
        f = fields(blob)
        # pl_from, pl_from_namespace, pl_target_id
        if len(f) < 3:
            continue
        try:
            pl_from = int(f[0])
        except ValueError:
            continue
        if pl_from not in want:
            continue
        try:
            lt_id = int(f[2])
        except ValueError:
            continue
        edges[pl_from].append(lt_id)
        seen.add(lt_id)
    names = target_titles(seen)
    return {pid: [names[i] for i in ids if i in names]
            for pid, ids in edges.items()}


def fetch(titles):
    """一覧記事の名前 → その記事が張っているリンクの並び。"""
    for name in (PAGE, LINKTARGET, PAGELINKS):
        if not have(name):
            download(name)
    sys.stderr.write("  記事の番号を引いています…\n")
    ids = page_ids_of(titles)
    missing = [t for t in titles if t not in ids]
    if missing:
        # **黙って飛ばしません。** 題が変わった（改名された）一覧は、
        # 0件として通すと「そういう一覧だった」ことにされます。
        sys.stderr.write(f"  （見つからない一覧: {' / '.join(missing)}）\n")
    sys.stderr.write(f"  リンクを読んでいます（{len(ids)}本ぶん）…\n")
    by_id = links_from(ids.values())
    return {t: by_id.get(pid, []) for t, pid in ids.items()}


if __name__ == "__main__":
    want = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not want:
        raise SystemExit("一覧の名前を並べてください。")
    for name, links in fetch(want).items():
        print(f"{name}\t{len(links)}件")
        print("  " + "、".join(links[:8]))
