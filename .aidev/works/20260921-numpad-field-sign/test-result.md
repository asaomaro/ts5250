# テスト結果: テンキーの ± と Field−

## 実行したもの
- web-ui `test/numpad-field-sign.test.ts`（8 件）・`field-sign-dup.test.ts`・`field-keystroke-rules.test.ts` ほか、キーマップ・先打ち・数値欄に触れる 18 ファイル — 448 passed / 0 failed。
  型検査（`vue-tsc --noEmit`。`tsconfig.json` と `tsconfig.test.json`）通過
- 実機（ACS のコア）: `scripts/acs-probe/field-minus-keys.txt`（1 回目は手順の書式の誤り＝空白 1 字の `keys` で実行前に止まった。空白の場合を外して流した）

## 受け入れ基準ごとの判定
- AC1: pass — `classifyKey` の 3 件、ペインで符号付き数値欄にテンキーの −（`    12-`・既定動作を止める）、DBCS 欄・英数字欄でテンキーの ＋。
- AC2: pass — 英数字欄の Field− は 0022・値とカーソルそのまま・次の文字も入らない（操作員エラー）、数字専用・継続欄も 0022、数値専用は通る、Field+ は次の欄へ。
- AC3: pass — 符号付き数値欄の `.` `,` `+` `-` 空白を拒否、`12-` は `12` のまま理由つき。
- AC4: pass — mutation N-a〜N-i の 9 通りすべて検出。

## 失敗の証跡

```
$ npx vitest run $(grep -ln "signKeyHack\|field-minus\|fieldMinus\|Field−\|signedNumeric\|classifyKey" test/*.ts)   # 実装を変えた直後
 FAIL  test/field-keystroke-rules.test.ts > ScreenGrid: 打鍵 > 符号付き数値欄では従来どおり `-` が Field− になる（退行防止）
 FAIL  test/field-sign-dup.test.ts > ScreenGrid: 数値欄の `-` / `+` は Field− / Field+ へ横流しされる > 符号付き数値欄で `-` を打つと**文字として入らず**符号桁が `-` になる
      Tests  6 failed | 146 passed (152)
```
旧い振る舞い（`signKeyHack`）を固定していたテスト 6 件。ACS の実測に合わせて書き換えた（D1。旧い見出しは取り消し線で残した）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 45923)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 実ブラウザ・実キーボードのテンキー（jsdom の `code` で確かめた）。NumLock を切ったテンキーは `code` が変わるので対象外。
