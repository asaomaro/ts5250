# テスト結果: ME・MF・自己点検を ACS と同じ時機・同じ条件で止める

## 実行したもの
- 全量 `npm test`（全ワークスペース）— すべて緑。web-ui **2225 passed**、tn5250 **708 passed**
- `npm run build`（root。web-ui の `vue-tsc` の test 込みを含む）・`npm run lint` — 通過
- 本 work で書き換え・追加したテスト: `ffw-behavior-bits.test.ts`・`self-check-field.test.ts`・
  `mandatory-check-acs.test.ts`（11 件）・`aid-data-mask.test.ts`（CA キーのスナップショット 1 件）

## 受け入れ基準ごとの判定
- AC1: pass — 未変更の画面では ME を見ない・変更済みなら Enter / CF の F キー / PageDown で止める・CA キーの F3 は通す・
  打ってから消した ME 欄（MDT あり・空）は通る。
- AC2: pass — MF の部分入力は、カーソルがその欄にあれば AID で止め、カーソルが無ければ AID では止めない（実機の場合 7）。
  Tab・クリックで出ると止めて欄の先頭へ戻す。自己点検も同じ。新しい画面の到着では検査しない。
- AC3: pass — 止めたらエラー状態に入る（次の文字は入らない）。ステータスバーのボタンはペインのカーソルで検査・送信する。
- AC4: pass — mutation 9 通りがすべて落ちた（X1 欄を出るとき 3 件 / X2 操作員エラー 3 / X3 ボタンのカーソル 1 /
  X4 CA キー 2 / X5 未変更 2 / X6 内容で判定 2 / X7 全欄で判定 1 / X8 Enter だけ 4 / X9 MF と自己点検の順 1）。
  旧決定 D1（`20260729-ffw-behavior-bits`）を取り消し線で残して破棄した。

## 失敗の証跡
このラウンドでは失敗が発生していない（旧テストは方針に合わせて先に書き換えた。書き換えた内容は D1 の破棄として `decisions.md` に記録）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- **実ブラウザでの操作確認は未実施**（jsdom のみ）。
- 空白だけを打った MF 欄（ACS はヌルだけを空とみなす。D2）。
- 実機の場合 7 は ECL の setcursor（マウス移動の検査を通らない）。GUI のクリックで出る場合は原典（`canCursorMoveByMouse`）に拠った。
