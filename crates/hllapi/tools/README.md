# `crates/hllapi` の道具

**実機（IBM i）に触れないもの**をここに置く。実機へ当てる E2E・診断は
リポジトリ直下の `scripts/`（あちらは「実機 E2E / 診断スクリプト」専用）。

> `scripts/` の `build-*.mjs` は **IBM i 上にテスト用の資産を作る**スクリプトで、
> ソフトウェアのビルドではない。同じ `build-` でも意味が違うので混ぜない。

| | 何をするか | 走る場所 |
|---|---|---|
| `build.sh` | 共有ライブラリをビルドする（**Windows 版も作れる**） | Linux / macOS |
| `build.ps1` | 同上（MSVC ツールチェーン） | Windows |
| `check-dll.py` | 出来たものを検査する（エクスポート名・**呼び出し規約**） | どこでも |
| `make-xlsm.ps1` | VBA を組み込んだ `.xlsm` を Excel に作らせる | Windows（要 Excel） |
| `find-hllapi.ps1` | **その PC に入っている HLLAPI 実装**を探す（ACS / PCOMM 等） | Windows |
| `update-prebuilt.sh` | **同梱している DLL を作り直す**（`../prebuilt/`） | Linux / macOS |
| `prebuilt-manifest.py` | 同梱 DLL の由来（ソース木の指紋・sha256）を作る | どこでも |

## 同梱している DLL（`../prebuilt/`）

**Rust の入っていない環境の利用者のために、ビルド済みを置いている。**

ビルド済みをリポジトリに置くと、**ソースを変えて作り直し忘れたときに黙って古いものが配られる**
——利用者側では気づきようがない。`manifest.json` にソース木の指紋を残し、
`packages/server/test/prebuilt-fresh.test.ts` が突き合わせる。**食い違えば `npm test` が落ちる。**

ソースを変えたら `update-prebuilt.sh` を実行すること。

```sh
crates/hllapi/tools/build.sh --windows          # .so ＋ DLL 64/32bit
python3 crates/hllapi/tools/check-dll.py <出力>  # ビルド後に自動で走る
```

`check-dll.py` を必ず通すのは、**ビルドが通ったことが正しさの保証にならない**ため。
32bit が `cdecl` のままだと VBA から呼んだ瞬間にスタックが壊れるが、**名前からは判別できない**。

実機を使う検証はこちら:

- `scripts/verify-hllapi.mjs` — 本物の C ABI ↔ 実機セッション
- `scripts/verify-hllapi-browser.mjs` — DLL → 実機 → 実物のブラウザ（Playwright）
