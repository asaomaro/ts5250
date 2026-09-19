# テスト結果: backlog 全件の要否判定と ACS との差異の洗い出し

この work の成果物は、台帳・突き合わせ表・検証スクリプトで、製品コード（`packages/*`）は変えていない。
そのため、検証は「受け入れ基準の機械的な照合」「スクリプトの実機での通し」「起動確認」の 3 つで行った。

## 実行したもの

- `python3 check_ac.py`（scratchpad の検査スクリプト。台帳と成果物を AC1〜AC7 で照合）— 136 passed / 0 failed / 0 skipped（2 回目）
- `aidev status` の件数（AC8）— 4 ファイルとも見込みと一致
- AC9 の検査 — 5 項目とも合格（`packages` の差分なし・ACS のファイルは追跡外・識別子と秘密 0 件・eslint 0 problems・実機のオブジェクトの作成なし）
- `node scripts/acs-probe.mjs scripts/acs-probe/attn-restore.txt` / `cursorcl3.txt`（実機）— 2 本とも期待どおり（coding の T10）
- `node scripts/verify-browser-reconnect.mjs`（既定 S1 S2 S3 S4 LAT、実機・実ブラウザ）— 10 OK / 0 NG（coding の T10）
- `node scripts/verify-browser-reconnect.mjs S4 S4a`（中継を直した版）— S4 は OK。S4a は NG で、N19 の再現として期待どおり
- `aidev smoke` — pass

## 受け入れ基準ごとの判定

- AC1: pass
  - 既存 16 件すべての台帳の行に、判定の行（`**判定（\`20260919-backlog-acs-triage\`…`）がある。
  - 処置（閉じる / 残す）が design の表と一致している。
  - 根拠（`file:line`・実測値・ACS のクラス.メソッドのいずれか）がある。
  - 検査スクリプトが、見出しで項目を特定して 16 × 3 項目を照合した。
- AC2: pass
  - 根拠は research F1 の現物（コード・テストの実行・実測）から取っている。
  - 食い違いには取り消し線を引いた（項目 4「単体実行では 8 件とも緑」、項目 10 の 4 ファイルと「機械判定になる」、項目 14・15 の「ACS の起動が必要」ほか）。
  - 一方、今も正しい「原因未特定」の取り消し線は、cross 点検の指摘で外した（decisions D11）。
- AC3: pass
  - 実測した項目は、値を書いた。
    - 項目 3: 1,117ms / 2,933ms / 29.7 秒 / 93.3 秒
    - 項目 8: 38〜76ms / 72〜137ms / 9〜75ms
    - 項目 14: 両者とも 3 行 12 桁
  - 実測しなかった項目は、理由を書いた。
    - 項目 13: 表が一致するので判定には要らない
    - 新規の DBCS プリンターと READ の無いアンロック: 「要実測」と測り方
- AC4: pass — 項目 9〜12 に、現在の数字（55 件 / 52 件、doctor の 5/20、87 行 / 0 行、2,186 行）がある。
- AC5: pass
  - `acs-comparison.md` に、3 領域の表と「対象外とした領域」の節がある。
  - 組は 60 行以上あり、どの行にも深さの記号がある。
- AC6: pass — 新規 22 件（acs-parity 19・session-lifecycle 3）すべてに、優先度・深さ・影響（3 行以上の本文）がある。
- AC7: pass
  - ACS との差異の起票 20 件には、ACS 側と当 PJ 側の両方の記述がある。△ の項目には、すべて「再確認」の注記がある。
  - session-lifecycle の 2 件は ACS との差異ではなく、当 PJ の欠陥なので、当 PJ 側の `file:line` を確かめた。
    - ping の見張り（N19）
    - プリンターの「＋新規」（F1-5）
- AC8: pass — `aidev status` の todo は、acs-parity 19 / code-quality-checks 2 / pc-command 0 / session-lifecycle 9 で、design「件数の見込み」と一致した。割った 2 件は、いずれも行頭（兄弟）にある。
- AC9: pass
  - `git diff --stat -- packages` は空。
  - ACS のファイルは追跡外（`IBMiAccess_v1r1/` は `.git/info/exclude`）。
  - 追加した行と新しいファイルに、`.env` / `.env.verify` の値 14 個と既知の固有名 4 つが 0 件。秘密らしい代入も 0 件。
  - 実機に作ったオブジェクトは無い（既存の CURSORCL3 を使っただけ）。スクリプトは最後に SIGNOFF する。

## 失敗の証跡

このラウンドでは、成果物の失敗は発生していない。
検査スクリプトの 1 回目は 2 件 FAIL だったが、これは**検査の対象の取り方が広すぎた**ためで、成果物の欠陥ではない。

- AC7 は「ACS との差異の主張」に掛かる基準だが、検査スクリプトは、当 PJ 自身の欠陥として起票した 2 件にも「ACS 側の記述」を求めていた。
- research の N19 も「ACS との差異ではなく、当 PJ の欠陥」としている。
- この 2 件は AC7 の対象外とし、代わりに当 PJ 側の `file:line` を確かめるよう検査を直した（2 回目は 136 passed）。
- 差し戻しはしていない。

```
$ python3 check_ac.py   # 1 回目
FAIL AC7 ACS 側と当 PJ 側 **クライアントの ping の見張りが、最初の ping
FAIL AC7 ACS 側と当 PJ 側 **プリンターの「＋新規」で同じ id に差し替わったとき、
TOTAL 134 passed / 2 failed
$ python3 check_ac.py   # 2 回目（当 PJ の欠陥 2 件を AC7 の対象外にした）
TOTAL 136 passed / 0 failed
```

参考: coding の工程では、半開きの検証（S4a）が中継の作り物で「検出した」と出る問題を見つけ、中継を直してから測り直した（decisions D10）。
直す前の出力（120.1 秒で OK）と、直した後の出力は次のとおり。

```
$ node scripts/verify-browser-reconnect.mjs S4a   # 中継を直す前
[128.0s]   OK  ping を受ける前の半開きも検出した（120108ms）
2 OK / 0 NG
$ node scripts/verify-browser-reconnect.mjs S4 S4a   # 中継を直した後
    [8.7s]   OK  メインメニューに着いた
    [8.7s] === S4: 最初の ping を受けてから半開き
    [32.8s]   OK  ping を受けた（24041ms 待った）
    [126.1s]   OK  約 93 秒で再接続中になった（93382ms）
    [126.9s]   OK  戻った（802ms）
    [126.9s] === S4a: ping を受ける前に半開き（N19 の再現。直るまで NG が正しい）
    [258.5s]   NG  ping を受ける前の半開きも検出した（-1ms）
    [261.9s] 
    4 OK / 1 NG
    exit=1
```

既定のシナリオ（中継を直す前の版で取った。S1〜S3 と LAT は中継の直しに関係しない。S4 は直した後の版でも 93.4 秒で OK）:

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-browser-reconnect.mjs
    [9.5s]   OK  メインメニューに着いた
    [9.5s] === S1: ユーザー・タスクの画面で 3 秒の断（RST＋拒否）
    [13.3s]   OK  同じ画面に戻った（戻してから 365ms）
    [13.5s]   OK  F3 がホストに通った（141ms。同じジョブが続いている）
    [13.5s] === S2: 応答待ち（DLYJOB 6 秒）の最中に 3 秒の断
    [20.2s]   OK  DLYJOB が終わった後の画面に戻り、応答待ちが解けた（戻してから 2702ms）
    [20.7s]   OK  続けて操作できた（256ms）
    [21.1s] === S3: 40 秒の断（はしごを使い切る）→ 手動の再接続
    [53.9s]   OK  「再接続」ボタンが出た（断から 32810ms）
    [62.5s]   OK  押すと元の画面に戻った（1323ms。サーバーの猶予 90 秒以内）
    [62.5s] === S4: 最初の ping を受けてから半開き
    [92.7s]   OK  ping を受けた（30256ms 待った）
    [185.4s]   OK  約 93 秒で再接続中になった（92711ms）
    [186.5s]   OK  戻った（1074ms）
    [186.5s] === LAT: 打鍵 → 描画（メニューの 1 と F3 を 15 往復）
    [195.9s]   打鍵→screen: n=30 p50=48ms p90=58ms
    [195.9s]   打鍵→描画・覆いの解除: n=30 p50=78ms p90=92ms max=106ms
    [198.2s] 
    10 OK / 0 NG
    exit=0
```

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260919-backlog-acs-triage
$ node launcher/smoke.mjs
{"level":40,...,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,...,"host":"127.0.0.1","port":45317,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 45317)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

- 新しく足したのは `scripts/` の検証スクリプトで、アプリの入口（サブコマンド・オプション）は足していない。
- どちらのスクリプトも実機と資格情報が要るので、`smokeCommands` には入れない。

## 未検証の穴（skip / 環境不足）

- **製品コードの単体テストは回していない。** `packages/*` を変えていないため。
- **`acs-probe.mjs` は、この環境の JDK 21 と Linux でしか通していない。** `PROBE_SCREEN=27x132` と `PUB400` の接頭辞では、実機に当てていない。
- **△ の差異**（新規のうち 7 件と、突き合わせ表の △ の行）は、委譲先の読みだけに拠る。修正に着手する work で、両側を再確認する前提（台帳に明記）。
- **DBCS プリンターの申告と、READ の無いアンロックは「要実測」のまま。** 実測は、修正に着手する work で行う。
- **項目 8（待たされる）の原因の確定には、利用者の確認が要る**（台帳に割った項目として残した）。

## ラウンド 2（review ラウンド 1 の指摘を反映した後。2026-09-19）

### 実行したもの

- `python3 check_ac.py` — 136 passed / 0 failed
- `aidev status` の件数 — acs-parity 19 / code-quality-checks 2 / pc-command 0 / session-lifecycle 9（見込みどおり）
- AC9 の検査
  - `git diff --stat -- packages` は空
  - ACS のファイルは追跡外。`IBMiAccess_v1r1/` は `.gitignore` でも除外済み（`git check-ignore` で確認）
  - 識別子の走査: 1 件ヒットしたが、問題なしと判断した（下の注）
- `scripts/acs-probe.mjs` の通し（実機）
  - `attn-restore.txt` と `cursorcl3.txt`: 期待どおり（欄への直接入力に変えたサインオンで通った）
  - 異常系 3 つ（未定義の命令・`_LIB` が無いのに `${LIB}`・資格情報が無い）: いずれも実機に繋ぐ前に exit 2
- `scripts/verify-browser-reconnect.mjs`
  - `S1 S2 S3 S4 S4a LAT`（実機・実ブラウザ）: 12 PASS / 1 FAIL。FAIL は S4a（N19 の再現）だけで、期待どおり
  - シナリオ名の打ち間違い（`s4a`）: exit 2
- `aidev smoke` — pass
- `npx eslint scripts/acs-probe.mjs scripts/verify-browser-reconnect.mjs` — 0 problems

注: 識別子の走査のヒット 1 件は `PUB400_HOST`（`pub400.com`）。公開の無料 IBM i のホスト名で、`scripts/README.md` の冒頭にも元から「既定 pub400.com」と書かれている。
`acs-probe.mjs` の PUB400 の既定値として使っていて、利用者の環境の固有名ではない。

### 受け入れ基準ごとの判定

AC1〜AC9 はラウンド 1 と同じく pass。
review ラウンド 1 の反映で、台帳（P2 への参照・S2 の項目の「FAIL」の表記）と `.gitignore` が変わった。その後も検査スクリプト・件数・走査の結果は変わらない。

### 失敗の証跡

このラウンドでは、成果物の失敗は発生していない。S4a の FAIL は、既知の欠陥 N19 の再現として期待どおりの結果。

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-browser-reconnect.mjs S1 S2 S3 S4 S4a LAT
[9.5s]   PASS メインメニューに着いた
[9.5s] === S1: ユーザー・タスクの画面で 3 秒の断（RST＋拒否）
[13.4s]   PASS 同じ画面に戻った（戻してから 576ms）
[13.8s]   PASS F3 がホストに通った（221ms。同じジョブが続いている）
[13.8s] === S2: 応答待ち（DLYJOB 6 秒）の最中に 3 秒の断
[21.7s]   PASS DLYJOB が終わった後の画面に戻り、応答待ちが解けた（戻してから 3734ms）
[22.0s]   PASS 続けて操作できた（225ms）
[22.4s] === S3: 40 秒の断（はしごを使い切る）→ 手動の再接続
[51.7s]   PASS 「再接続」ボタンが出た（断から 29327ms）
[64.9s]   PASS 押すと元の画面に戻った（2022ms。サーバーの猶予 90 秒以内）
[64.9s] === S4: 最初の ping を受けてから半開き
[94.4s]   PASS このソケットで ping を受けた（29439ms 待った）
[187.6s]   PASS 約 93 秒で再接続中になった（93198ms）
[188.0s]   PASS 戻った（451ms）
[188.0s] === S4a: ping を受ける前に半開き（N19 の再現。直るまで FAIL が正しい）
[189.2s]   PASS 新しいソケットで繋ぎ直した（1139ms）
[189.2s]   PASS 半開きにする時点で、このソケットはまだ ping を受けていない
[319.3s]   FAIL ping を受ける前の半開きも検出した（-1ms）
[320.6s] === LAT: 打鍵 → 描画（メニューの 1 と F3 を 15 往復）
[333.3s]   打鍵→screen: n=30 p50=68ms p90=98ms
[333.3s]   打鍵→描画・覆いの解除: n=30 p50=119ms p90=155ms max=206ms
[335.8s] 
12 PASS / 1 FAIL
exit=1
$ node --env-file=.env --env-file=.env.verify scripts/verify-browser-reconnect.mjs s4a
知らないシナリオ: s4a（使えるのは S1 S2 S3 S4 S4a LAT）
exit=2
$ node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs bad1.txt   # 未定義の命令
手順の誤り: 2 行目: 未定義の命令 foo
exit=2
$ node --env-file=.env scripts/acs-probe.mjs bad2.txt   # .env.verify を渡さない（_LIB なし）
手順の誤り: 2 行目: ${LIB} を使うが <接頭辞>_LIB が未設定（.env.verify）
exit=2
```

### 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 45863)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## ラウンド 3（review ラウンド 2 の指摘を反映した後。2026-09-19）

### 実行したもの

- `python3 check_ac.py` — 136 passed / 0 failed
- `aidev status` の件数 — 19 / 2 / 0 / 9（見込みどおり）
- AC9 の検査 — `packages` の差分なし・ACS のファイルは追跡外（`.gitignore` 済み）・識別子と秘密 0 件（公開ホスト `pub400.com` は除外。ラウンド 2 の注）・eslint 0 problems
- `scripts/acs-probe.mjs`
  - `attn-restore.txt`・`cursorcl3.txt`（実機）: 期待どおりで、exit 0
  - 異常系: 実機に繋ぐ前に exit 2（未定義の命令・`sleep 1.5s`・`setcursor 3`）
  - サインオンの失敗（存在しない利用者名で 1 回だけ）: exit 3 で止まり、続きの手順を 1 つも打たなかった
- `scripts/verify-browser-reconnect.mjs S1 S2 S3 S4 S4a LAT` — 12 PASS / 1 FAIL（FAIL は S4a＝N19 の再現だけで、期待どおり）
- `aidev smoke` — pass

### 受け入れ基準ごとの判定

AC1〜AC9 は pass（ラウンド 1・2 と同じ。スクリプトの修正は台帳と成果物の内容を変えていない）。

### 失敗の証跡

このラウンドでは、成果物の失敗は発生していない（S4a の FAIL は期待どおり）。

```
$ node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs bad3.txt   # sleep の書式の誤り
手順の誤り: 2 行目: sleep の引数はミリ秒の整数: 1.5s
exit=2
$ node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs bad4.txt   # setcursor の書式の誤り
手順の誤り: 2 行目: setcursor の引数は 行,桁: 3
exit=2
$ AS400_USER=NOSUCHUSR1 node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs scripts/acs-probe/attn-restore.txt
サインオンできませんでした（パスワード欄が残っている。資格情報・期限切れ・プロファイルの状態を確かめてください）
exit=3
$ node --env-file=.env --env-file=.env.verify scripts/verify-browser-reconnect.mjs S1 S2 S3 S4 S4a LAT
[10.8s]   PASS メインメニューに着いた
[10.8s] === S1: ユーザー・タスクの画面で 3 秒の断（RST＋拒否）
[15.3s]   PASS 同じ画面に戻った（戻してから 704ms）
[15.8s]   PASS F3 がホストに通った（347ms。同じジョブが続いている）
[15.8s] === S2: 応答待ち（DLYJOB 6 秒）の最中に 3 秒の断
[24.4s]   PASS DLYJOB が終わった後の画面に戻り、応答待ちが解けた（戻してから 4250ms）
[24.7s]   PASS 続けて操作できた（155ms）
[25.1s] === S3: 40 秒の断（はしごを使い切る）→ 手動の再接続
[52.9s]   PASS 「再接続」ボタンが出た（断から 27802ms）
[66.3s]   PASS 押すと元の画面に戻った（1132ms。サーバーの猶予 90 秒以内）
[66.3s] === S4: 最初の ping を受けてから半開き
[96.3s]   PASS このソケットで ping を受けた（29984ms 待った）
[189.5s]   PASS 約 93 秒で再接続中になった（93131ms）
[190.1s]   PASS 戻った（623ms）
[190.1s] === S4a: ping を受ける前に半開き（N19 の再現。直るまで FAIL が正しい）
[191.1s]   PASS 新しいソケットで繋ぎ直した（1008ms）
[191.1s]   PASS 半開きにする時点で、このソケットはまだ ping を受けていない
[321.4s]   FAIL ping を受ける前の半開きも検出した（-1ms）
[322.5s] === LAT: 打鍵 → 描画（メニューの 1 と F3 を 15 往復）
[329.9s]   打鍵→screen: n=30 p50=38ms p90=52ms
[329.9s]   打鍵→描画・覆いの解除: n=30 p50=65ms p90=87ms max=113ms
[332.2s] 
12 PASS / 1 FAIL
exit=1
```

### 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```
