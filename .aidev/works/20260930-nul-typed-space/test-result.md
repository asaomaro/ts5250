# テスト結果: 継続でない O 欄の空き（NUL）と空白

## 実行したもの
- `cd packages/web-ui && npx vitest run` — 3061 passed / 0 failed（231 ファイル）
- `cd packages/tn5250 && npx vitest run` — 1275 passed / 0 failed
- `cd packages/server && npx vitest run` — 1695 passed / 0 failed / 3 skipped（既存の skip）
- `npm run lint`・`vue-tsc -b` — エラーなし
- 実機（ブラウザ）: `verify-browser-space-typed.mjs`（O 欄 f3・f4。J・E は未対応の欄として比べない）pass=7、`o-field` 3、`cont-o` 24、`je-field` 3、`either-remainder` 4、`either-empty-view` 7、`cont-o-paste` 15、`cont-o-lone-shift` 16、`word-wrap` 8 — 全て fail=0（RA・TD の生バイトの変更のあとにビルドし直して再走行）
- 変異 15 通り — 14 を検出、1 つは等価（挿入で右へずらす桁の詰め物は、そのあと全て書き換わる）

## 受け入れ基準ごとの判定
- AC1: pass — `o-field-nul.test.ts`・`o-field-send.test.ts`・実機の f3・f4（READ MDT・ALT）
- AC2: pass — `o-field-nul.test.ts`（手前の空き・ホストの空白）・`o-field-send.test.ts`（RA・TD の 0x40）
- AC3: pass — `o-field-nul.test.ts`（必須埋め 4 件）
- AC4: pass — 実機の既存スクリプト 9 本が一致のまま

## 失敗の証跡
実機で修正前に走らせた `verify-browser-space-typed.mjs`（2026-10-01）:
```
FAIL T1 のバイト列が ACS と同じ
当 PJ: 11030a…11070ac111090ac1110b0a…
ACS:   11030a…11070ac14011090ac140110b0a…
FAIL T2 のバイト列が ACS と同じ
当 PJ: …0e448100000000000000000f…110d0a0e000000000000000000000f
ACS:   …0e448140400000000000000f…110d0a0e404000000000000000000f
```
（O 欄・半角の E が `c1`＝空白を落とす、J・E の打った全角空白が ALT で `00`）。テストの途中で落ちたもの: 12 件（`screen-grid.test.ts`・`delete-word.test.ts` ほか。End が空きを飛ばさない・入力欄に U+0000 が出る・期待が空白のまま）——原因を直すか、意味を確かめて期待を空きに直した（decisions D3・D4・D6）。

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実機の PUB400 のトレースに RA の 0x40 は出ていない（RA・TD の生バイトは単体で固定。実機の実例は未確認）
- J・G・全角の E・半角の E・通常の SBCS の欄は対象外（台帳）
