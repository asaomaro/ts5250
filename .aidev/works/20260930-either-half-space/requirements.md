# 要件: 半角の状態の E 欄の空き（NUL）と空白を区別する（ACS と同じ）

紐づく charter ゴール: charter.md なし（`.aidev/backlog/acs-parity.md`「E 欄の残り」の「継続でない O・J・E の値の空きと空白」のうち半角の E。利用者の指示「上の２項目に対応して」）

## 背景 / 課題
`20260930-nul-typed-space` で O 欄は打った末尾の空白を送るようにした。実機の ACS のコア（`scripts/acs-probe/space-typed.txt` の f2）は、半角の状態の E 欄に打った末尾の空白も送る（`A`＋空白 → `c1 40`。READ MDT・ALT とも）。当 PJ の E 欄は落としていた（`c1`）。

## 目的 / ゴール
半角の状態の E 欄が、打った空白（中身）と書かなかった桁（空き）の区別を保ち、ACS と同じバイト列をホストへ送る状態。

## ユーザーストーリー
- US1: E 欄（DBCS either）の利用者として、半角で打った末尾の空白も ACS と同じくホストへ送られてほしい。なぜなら欄データの長さや後続の処理が変わりうるから。（受け入れ: AC1, AC2）

## スコープ
### 対象
- web-ui: 半角の状態の E の値の空き（U+0000）: `trimPad`・`padDbcs`・`logicalFromCells`・`absorbDbcs`・End・貼り付けの詰め物・必須埋め
- core: E 欄の空白を生バイト 0x40 のセルにする

### 対象外（台帳に残す）
- J・G・全角の E に打った全角空白（詰め物が全角空白で区別できない）
- SI の無い E（open）の末尾の全角空白: 実機の ACS は `0e 4482 0e 4040 0f`（い＋Space の後で新しい `SO 4040 SI` の組）で、単純な `40 40` ではない（`space-typed-2.txt` の U1）
- 通常の SBCS の欄の末尾の空白（実測: ACS は `c1 40` を送る。当 PJ は落とす）

## 完了条件 (受け入れ基準)
- [ ] AC1: 半角の E に打った末尾の空白は落とさない（`A`＋空白 → `c1 40`。READ MDT・ALT とも）
- [ ] AC2: 手前の空きは NUL のまま、End は空きを飛ばし、挿入は末尾の空きを押し出して入り、必須埋めは空きがあれば満杯でない
- [ ] AC3: 実機の既存の E・O・J の測定（either-remainder・either-empty-view・je-field・o-field・cont-o）が変わらず一致する
