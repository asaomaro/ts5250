# タスク: 0x21 のメッセージを SOH のメッセージ行に重ねる

## 実装方針
core の `applyWriteErrorCode` で 0x21 にも位置を付け、テスト（core・web-ui）と実機の検証（当 PJ）を足す。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存の 0x21 のテスト・UI の最下行の表示が変わらないこと（24 行・全幅は従来の最下行と同じ見え方）。
- 台帳（`.aidev/backlog/acs-parity.md`）の消し込みと D2 の差（1 行を超えた続きは合わせない）の記録は **deliver で書く**（コードのタスクではないのでタスクにしない）。

## テスト方針
- core: 申告なし→{24,1,80}・SOH 22→{22,1,80}・長い本文でも幅 80（1 行）・範囲の外のセルは変わらない・0x22 の後の 0x21 で位置が 0x21 のものに替わる。既存の 0x21・0x22 のテストを回す。
- web-ui: 0x21 の位置（22 行・桁 1・幅 80）で `.opmsg-area` がその行に置かれる。既存の `host-error-mode` 等を回す。
- 実機: 検証スクリプトに 0x21 の 3 通りを足して ACS（research F2・F3）と比べ、測定の後に片付ける。

## タスク
- [x] T1: `applyWriteErrorCode` で 0x21 に `{ row: messageLineRow, col: 1, width: cols }` を付け、型のコメントを直す
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyWriteErrorCode`・`packages/tn5250/src/screen/types.ts` の `systemMessageArea` / 根拠: research A1
      依存: なし
      AC: AC1, AC2
- [x] T1b: メッセージ行を申告が無ければ最下行にし、CLEAR UNIT / CLEAR UNIT ALTERNATE / CLEAR FORMAT TABLE / SOH の入口で戻す（decisions D5。T1 の点検の must）
      対象: `packages/tn5250/src/screen/buffer.ts` の `clearFormatTable` `clearUnit` `clearUnitAlternate`・`wtd-applier.ts` の SOH 分岐
      依存: T1
      AC: AC1
- [x] T1c: システム・メッセージの寿命を「出した行」で判定する（decisions D6。cross 点検の指摘）
      対象: `packages/tn5250/src/screen/buffer.ts` の `clearSystemMessageIfTouched`
      依存: T1b
      AC: AC2
- [x] T2: core と web-ui のテストを直す・足す
      対象: `packages/tn5250/test/window-error-code.test.ts`・`packages/web-ui/test/window-error-code.test.ts` / 根拠: research A2
      依存: T1
      AC: AC1, AC2
- [x] T3: 検証スクリプトに 0x21 の 3 通りを足し、実機で測って片付ける（test 工程で消化）
      対象: `scripts/verify-window-error-code.mjs`・`scripts/host-src/dscmd.c`・`scripts/acs-probe/wec-msgline-row.txt`
      依存: T1
      AC: AC1, AC3, AC4
