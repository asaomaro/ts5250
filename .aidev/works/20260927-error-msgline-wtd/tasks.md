# タスク: エラー状態のままメッセージ行へ WTD・RESTORE が来たとき（調査）

## 実装方針
測定の資産と記録だけ。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- なし

## テスト方針
- 測定の再現（ACS のコア・当 PJ）。コードの変更は無い。

## タスク
- [x] T1: 測定の資産（DSM の ERRMSG*・ACS の台本・当 PJ の検証・README）
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/error-msgline-wtd.txt`・`scripts/verify-error-msgline-wtd.mjs`・`scripts/README.md`
      依存: なし
      AC: AC1, AC3
- [x] T2: 設計の材料を添えた起票（deliver で台帳に書く）
      対象: `.aidev/backlog/acs-parity.md`
      依存: T1
      AC: AC2
