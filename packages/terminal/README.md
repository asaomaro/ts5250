# @ts5250/terminal

5250 を**文字端末**（Windows Terminal・bash・tmux など）で操作する前面。接続と画面モデルは `@ts5250/tn5250`
（`Session5250`）を使い、ここは表示（ANSI）とキー解釈・制御だけを持つ。

```sh
ts5250-term --host <ホスト> [--tls] [--ccsid 1399] [--user U --password-env AS400_PASSWORD]
ts5250-term --replay packages/tn5250/test/fixtures/pub400-jobinfo.jsonl   # ホスト不要
```

第 1 段（現状）: 描画・AID 送信・フィールド移動・**SBCS の上書き入力のみ**。挿入・全角／DBCS 欄の入力・
Field Exit の整形・検証は、編集ロジックを web-ui から切り出す第 2 段で入れる。
経緯と実測は `.aidev/works/20261014-terminal-ui/`。下線・桁区切りは画面定義（DDS）に従い、代替の見せ方は足さない。
