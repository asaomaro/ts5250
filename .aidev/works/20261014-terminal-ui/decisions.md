# decisions: 文字端末の前面（第 1 段）

- D1: パッケージは `@ts5250/terminal`、`bin` は `ts5250-term`。依存は `base` と `tn5250` だけ（hostserver / tn3270 / vt / scs / ebcdic と同位。`dependency-direction.test.ts` に宣言）。
- D2: 接頭キーは `Ctrl+]`（tmux の Ctrl+B・screen の Ctrl+A と衝突しない）。`--prefix` で変えられる。利用者が決めなかったので既定を置いた——**変えてよい**。
- D3: 下線・桁区切りは DDS 準拠（利用者の判断）。`underline` → 実線、`columnSeparator` のみ → `4:4`。代替の見せ方は持たない。
- D4: 第 1 段の入力は SBCS の上書きのみ。全角・DBCS 欄・挿入は編集ロジックの切り出し（第 2 段）まで受けない（`note` で知らせる）。web-ui の編集を写し直さない。
- D5: 非 ASCII は 1 字ごとに CHA で桁固定。**試験が全角の右半分の二重計上（以降の桁が 1 字ごとに 1 桁ずれる）を捕まえた**——試作と同じ誤りを本実装でも書いており、`frame.test.ts` の「全角は CHA で桁を固定」で固定した。
- D6: `--replay <jsonl>` を CLI に足した（ホスト不要の確認・画面撮影用）。実機接続は利用者の設定の範囲でだけ。

## 未確認（第 1 段）
- 実機（IBM i）への接続は行っていない（設定が無いため。記録の再生まで）。
- Windows Terminal / VS Code 端末での表示は、利用者の判断（sodashitsu の端末版で表示できている）に依る。当 PJ では未実測。
- `4:4` の点線が出る端末・出ない端末（出ない端末では実線の下線に落ちる）。
