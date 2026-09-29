# タスク: 台帳を閉じる

## 実装方針
測る → 比べる → 記録する。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 必須でないという判断は利用者が覆せる形（理由を書く）で残す

## テスト方針
- 実機の比較 2 回

## タスク
- [x] T1: DSM の WDSFMINOR と ACS の probe
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/wdsf-minor.txt`
      依存: なし
      AC: AC1
- [x] T2: 当 PJ のコアの実機の検証
      対象: `scripts/verify-wdsf-minor.mjs`（新規）
      依存: T1
      AC: AC1
- [x] T3: 台帳の更新（#455 の実機の結果・残り 9 件の判断）
      対象: `.aidev/backlog/acs-parity.md`
      依存: T2
      AC: AC2
