#!/usr/bin/env python3
"""同梱 DLL の由来（ソース木の指紋と各 DLL の sha256）を作る／出す。

**なぜ指紋を残すのか。** Rust の入っていない環境のために DLL をリポジトリへ入れているが、
**ソースを変えて DLL を作り直し忘れると、黙って古いものが配られる**。
指紋を記録しておけば、検査（`prebuilt-fresh.test.ts`）がその食い違いを捕まえられる。

    python3 crates/hllapi/tools/prebuilt-manifest.py           # いまの指紋を出す
    python3 crates/hllapi/tools/prebuilt-manifest.py --write   # manifest.json を更新する
"""

import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def source_files() -> list[pathlib.Path]:
    """DLL の中身を決めるファイル。**ここに漏れがあると古い DLL を見逃す**"""
    return sorted([*(ROOT / "src").rglob("*.rs"), ROOT / "Cargo.toml", ROOT / "Cargo.lock"])


def source_hash() -> str:
    h = hashlib.sha256()
    for p in source_files():
        h.update(p.relative_to(ROOT).as_posix().encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def build() -> dict:
    out = {
        "source": {
            "sha256": source_hash(),
            "files": [p.relative_to(ROOT).as_posix() for p in source_files()],
        },
        "binaries": {},
    }
    for arch, rel in [("x64", "prebuilt/x64/ts5250hllapi.dll"), ("x86", "prebuilt/x86/ts5250hllapi.dll")]:
        p = ROOT / rel
        if not p.exists():
            continue
        b = p.read_bytes()
        out["binaries"][arch] = {"path": rel, "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)}
    return out


if __name__ == "__main__":
    m = build()
    if "--write" in sys.argv:
        (ROOT / "prebuilt/manifest.json").write_text(
            json.dumps(m, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print("prebuilt/manifest.json を更新しました")
    else:
        print(json.dumps(m, indent=2, ensure_ascii=False))
