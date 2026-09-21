# 設計

## 概要
- `onCompositionEnd` の流し込みを `commitInto(f, el, raws, start, replacedSelection)` に切り出し、入りきらなかった余りを返す（挿入で入らなければ 0012 を出して余りは無し）。満杯なら `advanceIfFull` が次の欄へ送る。
- `flowToNextField(from, rest)`: フォーカスが次の入力欄へ移っていれば（`document.activeElement`）、その先頭から `commitInto` を繰り返す（最大 16 欄）。移らなかった（FER・自動 Enter・1 欄・保護欄）ときは捨てる。
- SBCS の上書きで末尾に着いたら `break` して余りを返す（以前は `typeChar` が黙って捨てた）。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`、`packages/web-ui/test/ime-flow-next-field.test.ts`。

## 依拠する既存の事実
- `advanceIfFull`（満杯・FER・自動 Enter の判定と `field-full` の通知）、ペインの `onFieldFull`（次の入力欄へフォーカス）。

## インターフェース / データ構造
- `commitInto(...): string[] | undefined`（内部）・`flowToNextField(...): Promise<void>`（内部）。

## 振る舞いの詳細
- 流れるのはフォーカスが実際に次の欄へ移ったときだけ。次の欄は打鍵と同じく上書きで、先頭（0 桁）から。

## エラー処理 / 異常系
- 挿入で入らないときは 0012（従来どおり）で余りは捨てる。

## 受け入れ基準との対応
- AC1〜AC2: `ime-flow-next-field.test.ts` の 9 件（ペイン結合）。AC3: mutation 8 通り。
