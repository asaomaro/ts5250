# 計画: 05-trace-fixtures

> subtask の plan。**scope は親 plan が凍結済み**。自分の slice の分解のみ。

## この subtask の完了状態

**docker 無しで回帰が効く。** 照合で得た実バイト列を fixture に落とし、
replay で単体テストとして固定する。

## 実装方針

5250 側と同じ方式（言語非依存の JSONL trace を replay）に揃える。
`ReplayTransport` を作れば `Tn3270Session.attach()` にそのまま載る
（design D9 で `inbound` を無状態にした狙いがここで効く）。

## テスト方針

- `trace`: 記録した内容が JSONL として往復する
- `replay`: fixture を流して画面が期待どおりに組み上がる（docker 不要）
