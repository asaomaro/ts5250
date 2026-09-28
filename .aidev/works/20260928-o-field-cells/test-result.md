# テスト結果: O 欄の編集をセルの並びで行う

## 実行したもの
- 全量: tn5250 1,143 passed／server 1,660 passed・3 skipped／web-ui 2,916 passed。`npm run lint`・`npm run build`・web-ui の `vue-tsc` 込みのビルド exit 0
- 新規: web-ui `o-field-cells.test.ts`（純関数。ACS の実測 24 通り＋境目）・`o-field-edit.test.ts`（ScreenGrid の操作）・`o-field-explicit.test.ts`（明示の並びの計算）、tn5250 `o-field-cells.test.ts`（コアの送信・セル）
- 既存テストのうち O 欄の古い振る舞い（論理値・SO/SI を飛ばすカーソル・選択の置き換えの緩め）を固定していた 44 件を、ACS の規則に照らして見直した（下の証跡。どれも ACS の表・実測で説明がつく値に直し、見出しに理由を残した）
- mutation 27 通り（`scratchpad/mut-o.json`・`mut-o2.json`）——1 回目に 5 通りが生き残り（SI の飛び越し・空の組の Delete・後ろの並びを潰す行・セルから印を拾う・崩れた並びの組み直し）、試験を足して全部 KILLED
- 実機（社内機）:
  - ACS のコア `scripts/acs-probe/o-field-edit.txt`（DSM の OEDIT）: 24 通りすべてが原典の読みから立てた予測どおり
  - ブラウザの当 PJ `scripts/verify-browser-o-field.mjs`: 同じ打鍵（全角は CDP の IME）でホストが受け取ったバイト列が 3 巡とも ACS と同じ（pass=3。2 回）

## 受け入れ基準ごとの判定
- AC1: pass — 上書き 8・挿入 8 の実測と単体・ブラウザ
- AC2: pass — 削除系 8 の実測と単体・ブラウザ
- AC3: pass — コアの単体（別の並び・空の組・末尾の NUL・ALT・長さの見積もり）とブラウザの実機
- AC4: pass — 矢印が SO・SI に止まる（`screen-grid.test.ts`・`pane-nav.test.ts`）、Field Exit の欄の先頭は SO の桁（`field-exit-checks-wiring.test.ts`）

## 失敗の証跡
配線した直後の web-ui の全量（既存テストが古い振る舞いを固定していた）:

```
      Tests  44 failed | 2857 passed (2901)
 FAIL  test/screen-grid.test.ts > ScreenGrid > 既入力の後ろに IME 合成すると、既入力を残し候補が入力位置に出る（先頭に出ない）
AssertionError: expected '�あい� �えお' to be 'あいうえお'
```
この 1 件は配線の誤り（印の無い古い値のカーソルを SO/SI の桁で数えていなかった——`cellOfEntry`）で、直した。ほかは ACS の規則どおりの値で、期待を直した。
mutation の 1 回目:

```
SI の飛び越しを外す SURVIVED Tests  204 passed (204)
SO+SI を消さない SURVIVED Tests  204 passed (204)
後ろの並びを潰さない SURVIVED Tests  204 passed (204)
セルから印を拾わない SURVIVED Tests  204 passed (204)
崩れた並びを直さない SURVIVED Tests  204 passed (204)
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴
- 継続した O 欄（ACS `processCharWithDBCSOpenContField`）は対象外のまま
- 欄の次の桁が属性であること（SI の飛び越しの前提）を ACS が保証するかは原典で確かめられなかった（研究の UNKNOWN）。当 PJ は属性とみなす
- 挿入の押し出しで全角空白の組が割れる形は、当 PJ は空きに戻す（ACS は割れたバイトを持つ。原典どおりの形は表せない）
- 選択の置き換え・語の削除・複数行の貼り付けは当 PJ 独自（ACS に無い）。並びを組み直すので空の SO/SI は失う

## ラウンド 2（独立レビューの指摘を直した回）
- 全量: tn5250 1,145 passed／server 1,660 passed・3 skipped／web-ui 2,920 passed。lint・ビルド（web-ui の `vue-tsc` 込み）exit 0。smoke pass
- O 欄の貼り付けを 1 字ずつの打鍵にした（複数行・フォーカスしていない欄も）。単一行の挿入の貼り付けは ACS と同じく途中の字で止まればそこまで入る（事前の検査を外した）
- mutation 7＋1 通り（`scratchpad/mut-o4.json`）: 1 回目に「挿入の貼り付けを 1 字ずつにしない」が生き残り、挿入で別の並びができる試験を足して KILLED
- 実機のブラウザ `scripts/verify-browser-o-field.mjs` — pass=3（3 回目。コアの送信の書き方を変えた後）

```
挿入の貼り付けを 1 字ずつにしない SURVIVED Tests  129 passed (129)
```
変更の直後に落ちた既存の 1 件（単一行の挿入の貼り付けで、途中の字で止まればそこまで入る）:

```
 FAIL  test/dbcs-insert-sosi-room.test.ts > 貼り付け・IME の確定も同じ規則（C3・C4） > **貼り付け: 途中の字で止まれば、そこまでは入る**
      Tests  1 failed | 2919 passed (2920)
```
事前の検査が O 欄では 1 字ずつの試しに変わり、全体を弾いていた。O 欄では掛けないようにした。
