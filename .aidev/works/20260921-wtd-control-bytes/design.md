# 設計: 制御バイトの表示データ

## 概要
- `applyWtd` の主ループで、0x05〜0x0D・0x16〜0x1B を `switch` の前に拾い、1 桁の表示データ（空白。0x07 だけ DEL）として置く。元のバイトは `hostByte`（送信用）に持つ。`default:`（未知オーダー）と `isKnownCommand` は不要になるので撤去する。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`・`constants.ts`、`packages/tn5250/test/wtd-applier.test.ts`。

## 依拠する既存の事実
- `ScreenBuffer.setChar(addr, char, rawByte?, hostByte?)`（`packages/tn5250/src/screen/buffer.ts`）: `hostByte` は送信にだけ使う元バイト（0x1C・0x1E・`UNMAPPABLE` と同じ用途）。画面イメージ・SAVE の応答は `cell.rawByte ?? cell.hostByte ?? …` で書く（`save-screen.ts`）。
- 主ループは ESC・PC 標識・SO/SI・属性・DBCS・NUL・`UNMAPPABLE` を先に処理し、残りを `switch` で見る。0x1C・0x1E は `switch` の `case`。

## インターフェース / データ構造
- `isControlData(b): boolean`（0x05〜0x0D・0x16〜0x1B）と `controlDataText(b): string`（0x07 は `\u007f`、ほかは空白）。

## 振る舞いの詳細
- 制御バイトは 1 桁を占める（`addr++`）。`rawByte` は渡さない（カタカナ表示モードの読み替えを受けない。0x1C・0x1E と同じ）。警告は出さない。
- ~~未知オーダーとして次の ESC まで読み飛ばす~~ は破棄（`20260915-acs-protocol-order-audit` の「対象外」を破棄。decisions D1）。

## ドメイン固有の考慮
- 0x04 は ESC（次のコマンド）で、オーダーのパラメータ（SBA の行 4 など）にも現れるが、パラメータは各オーダーが読むので、主ループのデータとして現れない。

## エラー処理 / 異常系
- 範囲外・短いレコードの否定応答は別の作業。

## 受け入れ基準との対応
- AC1: 15 個をすべて当てるテスト（1 桁・警告なし）。
- AC2: 後ろの SBA・SF・IC・READ を検査。
- AC3: 画面イメージの応答に元のバイトが並ぶ。
- AC4: 0x07 だけ DEL・境界（SO/SI・0x1C〜0x1F）は従来。`isControlData` を 0〜255 全部で固定。
- AC5: mutation 11 通り（SO/SI まで含める 1 通りは、関数を 0〜255 全部で固定するテストを足して落とした）。
