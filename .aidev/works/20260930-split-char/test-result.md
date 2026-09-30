# テスト結果: 割れた全角の半分

## 実行したもの
- web-ui 3071・tn5250 1282・server 1695 passed / 3 skipped（既存）、lint・vue-tsc 緑
- 実機（ブラウザ）: `verify-browser-cont-o-last-lead.mjs` pass=2、cont-o 24・cont-o-paste 15・cont-o-lone-shift 16・cont-o-dead-kept 4・space-typed 9・o-field 3 — 全て fail=0
- 変異 13 通り — 12 を検出、1 つ（`normalize-chain`）は生き残った（下の未検証の穴）

## 受け入れ基準ごとの判定
- AC1: pass — 実機 C01（バイト列・カーソル）・`o-chain-cells.test.ts`・`o-chain-send.test.ts`・`split-char-session.test.ts`
- AC2: pass — 単体（型検証・桁数の検査・書き直しで消える・往復）

## 失敗の証跡
実機のブラウザの最初の走行（修正の途中）:
```
"result":"error","code":"FIELD_TYPE"      （検証が割れた半分を字として符号化できず）
"result":"error","code":"FIELD_OVERFLOW"  （桁数の検査が区間ごとに符号化して）
FAIL C01 のバイト列が ACS と同じ   当 PJ: （空）
```
原因は検証と桁数の検査が割れた半分を知らなかったこと（直して一致）。

## 起動確認（smoke）
smoke: pass

## 未検証の穴（skip / 環境不足）
- 割れた全角を含む鎖の Delete・Backspace・上書き（ACS の結果を測っていない）
- 変異 `normalize-chain` は生き残った（検証した範囲では等価。`normalizeO` の鎖の分岐は単体で分離して固定できていない）
