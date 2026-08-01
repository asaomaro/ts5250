# 決定記録

## D1. 撤去するのは `export` だけ、`import` は残す（spec 工程・2026-08-01）

`packages/tn5250/src` は `screen/` `protocol/` `session/` が内部で `@as400web/ebcdic` を使う。
これは正当な依存で、消すと TN5250 が文字を扱えなくなる。
禁じるのは **`export … from "@as400web/ebcdic"`** の形だけ。ガードもその形だけを見る。

## D2. web-ui の入口は狭いまま保つ（spec 工程・2026-08-01）

再輸出をやめると web-ui が EBCDIC を直接 import することになるが、
**バレル（`@as400web/ebcdic`）に向けると変換表 18,900 行が丸ごとバンドルに入る**。
`@as400web/ebcdic/catalog`（表ゼロ）/ `/katakana`（SBCS 部のみ）/ `/codec` を指す。

`20260801-library-extraction-tn5250` で `@as400web/scs` のバレルに向けて
**359,853 → 1,458,480 バイト（約 4 倍）**にした実例があるので、
バンドルの実測に頼らず**入口の指定そのもの**を走査で固定した（ガードの 5 番目）。

## D3. `codec-reexport.test.ts` は名前ごと作り直す（coding 工程・2026-08-01）

前身は「再輸出が到達可能なこと」を検査していたので、撤去で意味が反転する。
`ebcdic-not-reexported.test.ts` へ `git mv` して中身を逆にした——
中身だけ反転させると次に読む人が逆の期待をする
（`hostserver-not-reexported.test.ts` と同じ判断）。

前身は 4 件、新版は 6 件。**カバレッジの喪失ではない**——検査対象（再輸出）が
無くなったのであって、代わりに「戻っていないこと」と「web-ui が狭い入口を使っていること」を見る。

## D4. spec / plan を書く前に承認を記録してしまった（coding 工程・2026-08-01）

小さい項目なので手を抜き、`aidev approve spec` / `approve plan` を
**成果物を書く前に**実行した。記録と実体が食い違う状態を作ったので、
気づいた時点で spec.md / plan.md を書いて埋めた。

**承認は成果物があってこそ意味を持つ**。次から順序を守ること。
