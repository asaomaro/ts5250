# タスク: 0x22 のメッセージを ACS と同じ行・桁に出す

## 実装方針
core（位置と上限の計算・snapshot）→ web-ui（重ねる位置）の順。実機の検証資産は research で作ったものを使う。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 0x21 の見え方を変えない（位置は 0x22 のときだけ）。
- `systemMessage` が消えたあとに古い位置が snapshot に残らないこと。

## テスト方針
- core 単体: 0x22 の 4 通り（最下行／22 行 × 短い／長い）の位置と本文、上限を超えたバイトを次の ESC まで読み飛ばす（後続のコマンドは読む）、0x21 は位置なし、
  CLEAR UNIT・SAVE SCREEN・メッセージ行への WTD で消える（WTD は当 PJ の既存の規則）、`systemMessageSeq` が振られる、逆転した桁、先頭が 0x13 のとき上限 ＋3、
  桁の 2 バイトが無いレコードで例外にならない、**範囲の外のセルが変わらない**。既存の 0x21 のテスト（`write-error-code`・`system-message-lifetime`）を回帰として回す。
- web-ui 単体: `messageArea` を与えると `.opmsg` がその行・桁・幅に置かれる／無ければ従来どおり。EmulatorPane はホストのメッセージのときだけ渡す。
- 実機: `scripts/verify-window-error-code.mjs`（当 PJ）を ACS の測定（research F2・F3）と比べる。測定の後に片付ける。

## タスク
- [x] T1: core で 0x22 の開始桁・終了桁から位置と本文の上限を求め、`systemMessageArea` を snapshot に載せる
      対象: `packages/tn5250/src/protocol/wtd-applier.ts:368` `:997`・`packages/tn5250/src/screen/buffer.ts:1447`・`packages/tn5250/src/screen/types.ts:347` / 根拠: research A1・A2
      依存: なし
      AC: AC1, AC2, AC4
- [x] T2: core の単体テスト（4 通り・読み飛ばし・0x21・寿命〔CLEAR UNIT・SAVE SCREEN・WTD〕・通し番号・逆転・0x13・2 バイト欠け・範囲外のセル）
      対象: `packages/tn5250/test/`（新規 `window-error-code.test.ts`）
      依存: T1
      AC: AC1, AC2, AC4
- [x] T3: web-ui で `messageArea` の位置に `.opmsg` を重ね、EmulatorPane からホストのメッセージのときだけ渡す（テスト込み）
      対象: `packages/web-ui/src/components/ScreenGrid.vue:143` `:4436` `:4764`・`packages/web-ui/src/components/EmulatorPane.vue:1049` `:1604`・`packages/web-ui/test/`（新規） / 根拠: research A3・A4
      依存: T1
      AC: AC1
- [x] T4: 実機で当 PJ を測り（`scripts/verify-window-error-code.mjs`）、測定の後に DSCMD と IFS のファイルを消す（test 工程で消化）。測定の手順（DSM の WINERR*・acs-probe の手順・検証スクリプト）はリポジトリに残す（消すのは実機のオブジェクトと IFS のファイルだけ）
      対象: `scripts/verify-window-error-code.mjs`・`scripts/host-src/dscmd.c`・`scripts/acs-probe/window-error-code.txt`
      依存: T1
      AC: AC1, AC3, AC5
