# テスト結果: Backtab の行き先

## 実行したもの
- web-ui `test/backtab-acs.test.ts`（8 件）・`continued-field-tab.test.ts`・`cursor-progression-nav.test.ts`・`pane-nav*.test.ts`・
  `aid-field-exit-required.test.ts`・`keymap.test.ts` — 7 ファイル 97 passed / 0 failed。型検査（`vue-tsc --noEmit`）通過
- 実機（ACS のコア）: `scripts/acs-probe/backtab-home.txt`。1 回目は 1,1 の Backtab で ACS のコアが例外で止まり（下）、その場合を外して 2 回目を流した。
- 全量・lint・build は節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 実測の 4 例（7,22・7,20・3,20・7,26）。6,40（自由カーソル）は既存の位置探索（`pane-nav-from-protected.test.ts`）が同じ規則。
- AC2: pass — 行またぎの 2 行目・継続欄の最終区間・カーソル送りの逆引き・欄の途中では逆引きを見ない。
- AC3: pass — RZ に `12` → Backtab（同じ欄）→ Enter が送られる。mutation B-a〜B-d を検出。B-e（`caretAtFieldStart` の継続欄の補正）は
  等価（ペインが先に 2 区間目以降を寄せる）だったので補正ごと外した。

## 失敗の証跡

```
$ node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs scripts/acs-probe/backtab-home.txt   # 1 回目
=== b4 cursor=5,20 inhibit=0 insert=false commStatus=5 started=true autoReconnect=false
途中で止まりました: java.lang.ArrayIndexOutOfBoundsException: Index -1 out of bounds for length 1920
```
ACS のコアの不具合（DBCS のセッションで位置 −1 の SO を調べる）。当 PJ の失敗ではない。切断されたジョブが残っていないことを SQL で確かめた（0 件）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 44705)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 実ブラウザの Shift+Tab（jsdom のみ）。DBCS 欄の SO の直後での Backtab は論理位置 0 として扱った（ACS の SO の補正と同じ結果になるはずだが測っていない）。
