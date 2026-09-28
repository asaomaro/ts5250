# テスト結果: WDSF 0x52

## 実行したもの
- tn5250 `test/window-unrestrict.test.ts` — 7 passed。全量 1,134 passed（1 回目は既存 2 件が落ちた——下の証跡）／server 1,660 passed・3 skipped／web-ui 2,864 passed。lint・build exit 0
- mutation 5 通り（`scratchpad/mut-wu.json`）——すべて KILLED
- 実機（社内機）: `scripts/verify-window-unrestrict.mjs` — pass=3 fail=0。ACS のコア（ENPTUI を申告して 2 回）と同じ

## 受け入れ基準ごとの判定
- AC1: pass — 実機で WINRESTRICT は `[true]`、WINUNRESTRICT は `[false]`。単体で別のレコード・直近の窓だけ・窓が無いとき
- AC2: pass — 実機で中身 3 バイトはホストの次の読みが CPFA304（ACS と同じ）。単体で 0・1・3 バイトは 0x10050110 で制限が残る

## 失敗の証跡
変更の直後、以前の振る舞い（0x52 を読み飛ばす）を固定していた既存の 2 件が落ちた:

```
     × 未知の WDSF type は警告して読み飛ばす 44ms
     × ACS が受ける型（0x52・0x54・0x55）は、当 PJ が効かせなくても否定応答にしない 37ms
AssertionError: 0x52: expected 268763408 to be undefined
```
中身の無い 0x52 は ACS でも 0x10050110（原典 `unrestrictWindowCursor`）なので、テストを割って直した（未実装の例は 0x54 に差し替え）。

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴
- 画面の側の閉じ込め（web-ui）は `restrictCursor` を見るだけで変えていない。ペインで実際に窓の外へ矢印で出られるかは既存のテストの範囲

## ラウンド 2（レビューの指摘を直した回）
- tn5250 `test/window-unrestrict.test.ts` — 10 passed（REMOVE WINDOW の後・退避と復元・SOH の CSRINPONLY・`current` の印を足した）。web-ui `test/pane-cursor-window.test.ts` — 10 passed（最後に作った窓だけで閉じ込める）
- 全量: tn5250 1,137 passed／web-ui 2,865 passed／server は 3 件が落ち（認証・プリンター。この変更と無関係）、その 3 ファイルを再実行して 15 passed（load average 15.8〜21.8）。lint・build・web-ui の `vue-tsc` 込みのビルド exit 0
- mutation（`scratchpad/mut-wu2.json`・`mut-wu3.json`）: SOH で外す・印・ペインの 2 通り・退避・作ったら替える は KILLED。「消しても直近を残す」は番号で引くので等価（その行は外した）

```
 FAIL  test/app-auth.test.ts > 認証・per-user 分離 > 認証 ON: 未認証で保護ルートは 401、login 後は Cookie で通る
 FAIL  test/printer-hold-mcp.test.ts > MCP: 止めている帳票 > retry_printer_output はやり直す（また失敗すれば止めたまま）
 FAIL  test/printer-output.test.ts > handleReport > autoPrint は lp 不在なら warn して printed=false（degrade）
      Tests  3 failed | 1657 passed | 3 skipped (1663)
$ npx vitest run test/app-auth.test.ts test/printer-hold-mcp.test.ts test/printer-output.test.ts   # load average: 15.80, 21.79, 18.18
      Tests  15 passed (15)
```

## 未検証の穴（追記）
- 退避と復元を挟んだ後の ACS の `enpwindow`（当 PJ は持ち回る）
- ペインの閉じ込めの変更（最後に作った窓だけ）は実機のブラウザで操作していない（単体のみ）
