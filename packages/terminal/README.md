# @ts5250/terminal

5250 を**文字端末**（Windows Terminal・bash・tmux など）で操作する前面。接続と画面モデルは `@ts5250/tn5250`
（`Session5250`）を使い、ここは表示（ANSI）とキー解釈・制御だけを持つ。

```sh
ts5250-term --host <ホスト> [--tls] [--ccsid 1399] [--user U --password-env AS400_PASSWORD]
ts5250-term --replay packages/tn5250/test/fixtures/pub400-jobinfo.jsonl   # ホスト不要
```

現状（第 3 段）: 描画・AID 送信・フィールド移動に加え、文字欄と O 欄の編集（挿入／上書き・Delete・Backspace・
Field Exit・型の検査・O 欄の SO/SI 補完）。規則は web-ui と同じ `@ts5250/tn5250/edit/*` を呼ぶ。
第 4 段で継続欄（EDTMSK の区間の並び。1 つの欄として挿入・Delete・Backspace・Field Exit）と語送り欄を足した。
**未対応**: J／E／G 欄・継続した O 欄・Field＋／Field−（欄に打とうとすると「未対応」と知らせて値を変えない）。
挿入は Insert キーまたは接頭キーの `i`。AID の送信で上書きへ戻る。
経緯と実測は `.aidev/works/20261014-terminal-ui/`。下線・桁区切りは画面定義（DDS）に従い、代替の見せ方は足さない。
