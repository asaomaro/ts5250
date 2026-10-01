# テスト結果: 最後の残り

## 実行したもの
- web-ui 3086・tn5250 1289・server 1695 passed / 3 skipped（既存）、lint・vue-tsc 緑
- 実機（ブラウザ）: `verify-browser-open-e.mjs` pass=12、`verify-browser-sbcs-space.mjs` pass=6（通常の欄 `c1 40`・open の E・compact の E）。既存: word-wrap 8・sign-digit 4・progression-range 3・cursor-progression・command-prompt・udc-roundtrip が緑のまま
- 変異: open の E 5 通り（等価 1）・通常の欄 5 通り — 等価 1 を除き全て検出

## 受け入れ基準ごとの判定
- AC1: pass — 実機 12 の比較・`open-e.test.ts`
- AC2: pass — 実機 6 の比較・`o-field-nul.test.ts`
- AC3: pass — 測定（`cont-o-split-edit.txt`）を台帳に残し、合わせない理由を decisions D1 に実測つきで記録

## 失敗の証跡
実機の既存スクリプトのうち失敗したもの（いずれも今回の変更前から）:
```
adjust / cmdline / ffw / prompt / select / sign: TypeError: Cannot read properties of undefined (reading 'signon') / raw.profiles is not iterable （設定ファイルの旧い形式。起動できない）
edtmsk-edit: FAIL 後戻りも並びを 1 つとして飛び越す（実際 f23c24）   （main でも同じ）
keystroke-rules: FAIL `.` が入らない（実際 "1"）   （main に戻して走らせても同じ。数字専用の欄の `.` の通知後の打鍵の扱いで、通常の文字欄の変更とは別）
```
今回のラウンドで新しく起きた失敗はない。

## 起動確認（smoke）
smoke: pass

## 未検証の穴（skip / 環境不足）
- 設定形式が旧い実機スクリプト 6 本（adjust・cmdline・ffw・prompt・select・sign）は走らない。通常の文字欄の主要な経路は単体と上の実機で確かめた
- 数値・右寄せなどの欄の末尾の空白（対象外）
