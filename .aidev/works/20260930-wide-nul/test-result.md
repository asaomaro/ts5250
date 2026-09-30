# テスト結果: 全角 1 桁の空き

## 実行したもの
- 後述の全体テスト・lint・型検査
- 実機（ブラウザ）: `verify-browser-space-typed.mjs` pass=12（J・E・E・O・O・J の READ MDT と ALT が全て ACS と一致）、je-field 3、either-remainder 4、either-empty-view 7、o-field 3、cont-o 24 — 全て fail=0
- 変異 10 通り — 全て検出（最初の走行で生き残った 1 件〔読み戻しの空きの対〕はテストを足して検出）

## 受け入れ基準ごとの判定
- AC1: pass — 実機 12 の比較
- AC2: pass — `wide-nul.test.ts`
- AC3: pass — `wide-nul.test.ts`・既存の実機スクリプト

## 失敗の証跡
修正前の実機（`20260930-nul-typed-space` の test-result に記録）: `T2 の f0 当 PJ: 0e448100000000000000000f / ACS: 0e448140400000000000000f`（打った全角空白が消える）。テストの途中で落ちたもの: 10 件（J・G・E の既存テストの「ホストが 4040 で埋めた」前提）——意味を確かめて期待を直した（decisions D3）。

## 起動確認（smoke）
smoke: pass

## 未検証の穴（skip / 環境不足）
- open の E と通常の SBCS の欄は対象外（台帳）
