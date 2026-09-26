# 仕様: 0x22 のメッセージを ACS と同じ行・桁に出す

## 概要
core が 0x22 を受けたとき、ACS と同じ規則（research F1）で「重ねる位置（行・書き始めの桁・幅）」と本文の上限を求めて snapshot に載せ、
UI は位置があればそこへメッセージを重ねる（無ければ従来どおり最下行）。エラー状態の入り方・抜け方は 0x21 と同じ経路のまま（research F4・F6）。

## 設計方針
- **セルには書かず、重ねる**（既存の 0x21 と同じ作り）。重ねる範囲を ACS の「空にする桁 ∪ 書いた桁」に合わせれば見え方が ACS と同じになり、抜けたときの復元も「隠す」だけで済む（research F6）。
- 位置の計算は core に置く（画面の大きさ・メッセージ行を知っているのは core）。UI は受け取った位置に置くだけ。
- 退けた案: 本文をセルへ書き、抜けたときに元へ戻す（ACS の作り）——退避・復元の仕組みを 0x21 まで含めて作り直すことになり、既存の寿命の規則（`clearSystemMessageIfTouched`）と二重になる。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`（0x22 の読み方・上限・位置の計算）
- `packages/tn5250/src/screen/buffer.ts`（位置の保持と snapshot への載せ方）
- `packages/tn5250/src/screen/types.ts`（`ScreenSnapshot.systemMessageArea`）
- `packages/web-ui/src/components/ScreenGrid.vue`（`messageArea` prop と `.opmsg` の置き方）
- `packages/web-ui/src/components/EmulatorPane.vue`（ホストのメッセージのときだけ位置を渡す）
- テスト（core・web-ui）と、実機の検証資産（`scripts/host-src/dscmd.c` の WINERR*・`scripts/acs-probe/window-error-code.txt`・`scripts/verify-window-error-code.mjs`）

## 依拠する既存の事実
- ACS の 0x22 の位置・上限・抜け方: research F1〜F4（原典と実測）。
- 当 PJ の 0x22 の読み方と `systemMessage` の寿命: research F5・F6（`wtd-applier.ts:368`・`:997`、`buffer.ts` の `clearSystemMessageIfTouched`）。
- メッセージ行の行番号は `msgLineRow`（research A2。読み取りは `ScreenBuffer.messageLineRow`。SOH の申告、既定 24）。
- DSM の試験プログラムの IFS のファイルは `/tmp/dscmd.c`・`/tmp/dscmd.log`（`scripts/build-dscmd.mjs:28-29` の既定）。
- `.opmsg` の置き方と、桁で置くオーバーレイの前例 `.colsep`（research A3）。

## インターフェース / データ構造
- `ScreenSnapshot.systemMessageArea?: { row: number; col: number; width: number }`（1 起点。`systemMessage` があり、かつ 0x22 由来のときだけ付く）。
  `col` は書き始めの桁（ACS の属性の桁）、`width` は重ねる桁数。
- `ScreenBuffer.systemMessageArea: { row; col; width } | undefined`（WRITE ERROR CODE が届くたびに上書き。0x21 では undefined）。
- `ScreenGrid` の prop `messageArea?: { row: number; col: number; width: number }`。

## 振る舞いの詳細
- 0x22: 開始桁 `sc`・終了桁 `ec` を読む。`rowStart = (メッセージ行 − 1) × 桁数`、`s = rowStart + sc − 1`、`e = rowStart + ec − 1`、`limit = ec − sc + 1`（バイト。本文の先頭が 0x13 なら ＋3）。
  `s + 桁数 > 行数 × 桁数` なら `s = (行数 − 1) × 桁数`（最下行の行頭。`e` は変えない）。
  本文は先頭から `limit` バイトまで読み（属性・SO/SI・DBCS の 2 バイトも数える）、残りは次の ESC まで読み飛ばす（どちらも research F1）。
  重ねる範囲 = [`s`, max(`e`, `s` ＋ 読んだバイト数)) → `row = ⌊s / 桁数⌋ + 1`、`col = s mod 桁数 + 1`、`width = 範囲の桁数`。
- 0x21: 従来どおり（位置なし＝UI は最下行）。
- UI: ホストのメッセージを出していて `systemMessageArea` があれば、`.opmsg` をその行・桁・幅に置く（桁 1 を空ける既存の字下げ＝属性の桁はそのまま）。`.opmsg` は地の色で塗る（既存）ので、
  本文が短くても幅全体で下のセルを隠す＝ACS の「範囲を空にする」と同じ見え方。クライアント側の操作員メッセージのときは従来どおり最下行。
- 寿命: `systemMessage` と同じ。core では CLEAR UNIT・SAVE SCREEN・メッセージ行への書き込みで消える。**Reset 等では core は消さず、UI が隠す**（`hostErrorDismissedSeq`。research F6）——snapshot は Reset 後も位置を載せ続けるが、UI は出さない。

## ドメイン固有の考慮
- ACS が最下行で開始桁を捨てるのは、見た目では不自然だが ACS の実装と実測どおりに合わせる（AGENTS.md「判断の原則」1。情報を捨てる類の差ではない）。
- 本文の先頭が属性でないときも UI は桁 1 を空ける（既存の 0x21 と同じ扱い）。ACS はそのバイトを書くので 1 桁ずれうる——実例が無いので未確認として残す。

## エラー処理 / 異常系
- `ec < sc`（逆転）: `limit` が 0 以下になるので本文を読まない。重ねる範囲は [`s`, `e`)。最下行以外では空＝幅 0 で何も重ねない。
  最下行では `s` を行頭へ戻し `e` は戻さないので、幅 `ec − 1` の範囲が空欄として重なる（式どおり。ACS の実測は無く**未確認**）。
- 開始桁・終了桁の 2 バイトが無い（レコードの終わり）: 従来どおり読める範囲で止める（例外にしない）。

## 受け入れ基準との対応
- AC1: 上の計算で、実機の 4 通り（最下行・22 行 × 短い・長い）の行・書き始めの桁・本文が ACS と一致する——`scripts/verify-window-error-code.mjs`（core の snapshot）と、同じ位置を与えた `ScreenGrid` の描画のテストで確かめる。範囲の外の桁はセルを書かないので変わらない（core のテストでセルが変わらないことも見る）。
- AC2: エラー状態の入り方・Reset の抜け方は 0x21 と同じ経路（`systemMessageSeq` → UI のエラー状態）。既存の 0x21 のテストが通ること・0x22 でも `systemMessageSeq` が振られることを core のテストで確かめる。
- AC3: research F1〜F4 と、測定の手順（DSM のモード・`acs-probe` の手順・当 PJ の検証スクリプト）をリポジトリに残す。
- AC4: CLEAR UNIT・SAVE SCREEN で `systemMessage` と位置が消える（snapshot に載らない）ことを core のテストで確かめる（ACS の `processClearUnit`・`processSaveScreen` と同じ。research F4）。
  メッセージ行への WTD で消えるのは当 PJ の既存の規則（research F6）で、**ACS がエラー状態のままメッセージ行へ WTD を受けたときの見え方は未確認**（ACS はセルに書き、抜けるときに戻す）。0x21 と同じ扱いを保ち、差の確認は 0x21 の起票（D2）と一緒に残す。
- AC5: 測定の後に `DSCMD` と IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log` を消し、`test-result.md` に記録する。
