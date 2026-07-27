# 計画: DSPATR(CS)（桁区切り）を画面に表示する

## split 判定
分割しない（2 ファイル・数行）。

## 作業順序
1. T1 落ちるテストを書く
2. T2 `cellClass` / `attrByteClass` に `a-colsep`、styles.css に border-left
3. T3 通し確認

## リスク
| # | リスク | 対応 |
|---|---|---|
| R1 | 既存画面に意図しない縦線が増える | `columnSeparator` はホストが明示した桁だけ真。無い画面に出ないことをテストで固定 |
| R2 | 反転セルで線が見えなくなる | `currentColor` を使う（反転時は前景色が CRT 地色になり、線もそれに従う） |
| R3 | 入力欄の中だけ線が出ない | `attrByteClass` にも入れる（spec D2） |

## テスト方針
- `a-colsep` の有無・他属性との併用
- 既存の web-ui テストが全通過
- 全体: build / test / lint / vue-tsc
