# レビュー: backlog-acs-triage

## タスク点検ログ

### cross（2026-09-19・delegated・15 件。すべてその場で対応。decisions D11）

- [should] S4 の実測値（93.3 秒・632ms と 93.4 秒・802ms）が、どちらの中継のものか文書間で読み取れない → research F2 の注に、S4b は中継の違いに左右されないことと両方の値を明記 [conv:-]
- [should] 項目 8 の「再現条件・原因未特定」は今も正しいのに取り消し線が引かれていた → 取り消し線を外した [conv:-]
- [should] 閉じた項目の区分が design の 3 区分・FR1 と揃っていない → 3 区分＋「: 補足」に統一 [conv:-]
- [should] 台帳の出典に research に無い委譲先のラベル（L1〜L15・A1〜A16・B4〜B11）がある → 外して `acs-comparison.md` の領域を指した [conv:comment-provenance!]
- [should] 台帳の数値の一部（57 件・261 行・25,897 行など）が research に無い → research F1 に追記 [conv:comment-provenance!]
- [nit] 「項目 8」が台帳の中で解決できない → 見出しで引いた [conv:comment-provenance]
- [nit] 「freeze work」に slug が無い → `20260910-session-reconnect-freeze` に [conv:comment-provenance]
- [nit] 突き合わせ表が Clear/Help/Print の欄データを P17 に入れていた（台帳は P16 だけ）→ P16 に直した。P17 の優先度の差は D11 で意図を記録 [conv:-]
- [nit] 要判断の範囲が design・D6 より広い（P11・0020）→ 意図を D11 に記録し、P11 に選択肢 A/B を付けた [conv:-]
- [nit] P15（△）を 1 件で起票したのは D5 の方針と違う → 方針判断の項目の例外として D11 に記録（直さない） [conv:-]
- [nit] 件数の内訳が文書間で違う（design 5＋1、D5 の 4）→ design を 4＋2 に直し、D5 の誤りを D11 で訂正 [conv:-]
- [nit] D9 の「session-lifecycle は 2 桁」が事実と違い、1 ファイルに 2 つの書き方が混在 → S1〜S3 を 6 桁に揃え、D9 の誤りを D11 で訂正 [conv:-]
- [nit] README に事前ビルドと `PROBE_PORT` が無い → 追記（`acs-probe.mjs` の冒頭にも `PROBE_PORT`） [conv:-]
- [nit] LAT の「15 往復」と「30 往復」が混在 → 「`1` と F3 の 15 往復＝打鍵 30 回」に統一 [conv:-]
- [nit] `attn-restore.txt` の見出しの引用が台帳の実際の見出しと違う → 台帳の見出しに合わせた [conv:-]

## ラウンド 1（2026-09-19）

対象: 台帳 4 ファイル・`scripts/README.md` の差分、新規の `scripts/acs-probe.mjs`・`scripts/acs-probe/`・`scripts/verify-browser-reconnect.mjs`・work フォルダ。
`aidev coverage` は tasks 時と同じ（gap 0）。要件適合（AC1〜AC9）・価値適合（台帳が次の work の requirements にそのまま使える形か）は満たしている。
指摘はスクリプトの正確性と保守性に集中した（正確性・保守性の点検は別コンテキストと併用。must 0・should 12・nit 14）。

- [should] `verify-browser-reconnect.mjs` のサーバーが全インターフェースで待ち受ける。認証オフ・自動サインオンの設定のまま、同じネットワークの他者が開ける（AGENTS.md「認証オフの HTTP は既定で 127.0.0.1 のみ」） — 根拠: scripts/verify-browser-reconnect.mjs:77 [conv:-]
- [should] S4 の「最初の ping を受けた」が、ページを開いてからの全ソケットの記録を見ている。シナリオの順やサインオンの遅さで、ping 未受信のソケットを半開きにして偽 NG になる — 根拠: scripts/verify-browser-reconnect.mjs:243 [conv:-]
- [should] S2 の `!/DLYJOB/.test(grid())` は常に真（コマンド行は `<input>` の value で、`.grid` の textContent に含まれない）。DLYJOB の前の画面に戻っても OK と出る — 根拠: scripts/verify-browser-reconnect.mjs:220 [conv:-]
- [should] シナリオ名を検証しない。打ち間違えると何も走らず exit 0（偽の合格） — 根拠: scripts/verify-browser-reconnect.mjs:46 [conv:-]
- [should] `AcsProbe` が接続の成否を確かめない（`IsCommStarted()` が偽でも続行して exit 0） — 根拠: scripts/acs-probe/AcsProbe.java:75-77 [conv:-]
- [should] `AcsProbe` の手順ループに try/finally が無い。例外で `StopCommunication` も `exit` も通らず、JVM が 300 秒残る — 根拠: scripts/acs-probe/AcsProbe.java:80-107 [conv:-]
- [should] `signon` が、10 文字の利用者名（自動送りでパスワード欄を飛ばす）や `[` を含むパスワード（SendKeys のニーモニック）で壊れ、QMAXSIGN を消費しうる — 根拠: scripts/acs-probe/AcsProbe.java:88-91 [conv:-]
- [should] Java の標準出力を OS 既定の文字コードで出す。C ロケールでは日本語が `?`、Windows では MS932 と `\r` が混じる — 根拠: scripts/acs-probe.mjs:81-85、AcsProbe.java:34-38 [conv:-]
- [should] `PROBE_CODEPAGE` の既定 930 が PUB400 にも掛かる。930 の SBCS には英小文字が無く、QPWDLVL 3 の PUB400 でサインオンが失敗しうる — 根拠: scripts/acs-probe/AcsProbe.java:64 [conv:-]
- [should] 出力を伏せる対象が、パスワードとホストだけ。利用者名も `.env` の値（AGENTS.md「値を出力・転記しない」） — 根拠: scripts/acs-probe.mjs:88 [conv:-]
- [should] 作業ディレクトリが、全利用者で共有される固定パス（`tmpdir()/ts5250-acs-probe`）で、既存の class・印を信用する。共有 /tmp で他者のコードが資格情報を持つ JVM で動きうる — 根拠: scripts/acs-probe.mjs:57-73 [conv:-]
- [should] 既定の jar の置き場がリポジトリの中なのに、`.gitignore` に無い（clone ごとの `.git/info/exclude` 頼み）。README どおりに置いた人が IBM の頒布物をコミットしうる → 利用者の判断で `.gitignore` に足す — 根拠: scripts/README.md:723、.gitignore [conv:-]
- [nit] `jar xf` は指定の項目が無くても exit 0。古い acshod2.jar を使い続けうる → 取り出す前に消す — 根拠: scripts/acs-probe.mjs:64-67 [conv:-]
- [nit] 必要な JDK の版を書いていない（switch の `->` は 14 以上） — 根拠: scripts/acs-probe/AcsProbe.java:85、scripts/README.md:725 [conv:-]
- [nit] `process.env` をまるごと JVM に渡している（最小限にする） — 根拠: scripts/acs-probe.mjs:85 [conv:-]
- [nit] `PUB400_HOST` を必須にしているが、README 冒頭は任意（既定 pub400.com） — 根拠: scripts/acs-probe.mjs:41-43、scripts/README.md:25 [conv:-]
- [nit] `${LIB}` が空のまま、あるいは未知の命令のまま続行して exit 0 — 根拠: scripts/acs-probe/AcsProbe.java:94、:102 [conv:-]
- [nit] S4a で、半開きにする前の復帰の成否と、新しいソケットが ping 未受信であることを確かめていない — 根拠: scripts/verify-browser-reconnect.mjs:256-259 [conv:-]
- [nit] 一時の profiles.json を try より前に作る。起動失敗や EADDRINUSE で残る — 根拠: scripts/verify-browser-reconnect.mjs:59-68、:77、:104 [conv:-]
- [nit] コメントの「すべて RST」「接続拒否」が実装（上流は FIN、accept してから RST）と違う — 根拠: scripts/verify-browser-reconnect.mjs:4、:84-86、:105-107 [conv:-]
- [nit] 集計に使わない記録（`key-done`・`grid:`）を積み、LAT の経路に負荷を足す — 根拠: scripts/verify-browser-reconnect.mjs:125、:137-138 [conv:-]
- [nit] `replace(/^0+/, "")` が桁の目盛り（`.cell-ruler`）が先頭である前提に依存し、操作員メッセージが出ていると偽 NG — 根拠: scripts/verify-browser-reconnect.mjs:171 [conv:-]
- [nit] 近くのスクリプトと出力の書式（OK/NG と PASS/FAIL）・システム id・CCSID が違い、理由が無い — 根拠: scripts/verify-browser-reconnect.mjs:55、:65 [conv:-]
- [nit] README の S4 の実測値が D10 の前の中継の値。research の「S4b」とスクリプトの「S4」の呼び名の対応も書いていない — 根拠: scripts/README.md:772 [conv:-]
- [nit] AGENTS.md の残課題「挿入モードで 1 行が帯の幅を越えたときの ACS 挙動が未確認」に、P2 で読んだ `reserveRoomForInsert` が関係する。台帳の P2 に参照を添える — 根拠: AGENTS.md:375、.aidev/backlog/acs-parity.md の P2 [conv:-]
- [nit] `PROBE_*` の受け渡しが `acs-probe.mjs` と `AcsProbe.java` の 2 か所に分かれる（README の一覧で対応を取る。テストでの固定まではしない） — 根拠: scripts/acs-probe.mjs:79-85、AcsProbe.java:60-67 [conv:paired-artifact-sync]

## ラウンド 2（2026-09-19）

対象: ラウンド 1 の指摘を反映した `scripts/acs-probe.mjs`・`scripts/acs-probe/AcsProbe.java`・`scripts/verify-browser-reconnect.mjs`・README の 2 節・`.gitignore`。
ラウンド 1 の指摘はおおむね直っていた。ただし、**直したことで入った退行**が 2 件あった（別コンテキストの点検と併用。must 0・should 2・nit 6）。
2 件はどちらも同じ不変条件（「最後まで正しく流れたときだけ成功を返す＝偽の合格を出さない」）を支える箇所なので、
直すときは、その条件を支える箇所をすべて列挙して直す（例外の種類・サインオンの成否・手順の引数・起動口の終了コード・S4a の競合）。

- [should] `AcsProbe` の try が拾うのは `Exception` だけ。`Error`（`NoClassDefFoundError` など）では `code` が 0 のまま `finally` の `System.exit(0)` に着き、出力なしで exit 0（偽の合格）になる。ラウンド 1 の修正で入った退行 — 根拠: scripts/acs-probe/AcsProbe.java:176-189 [conv:-]
- [should] 終了コード 3 を「接続・サインオンできない」と書いたが、`signon` は成否を確かめない。資格情報の誤りでもサインオン画面のまま Enter を重ねて exit 0（試行が積み上がる）。README の「3 = 接続できない」とも食い違う。ラウンド 1 の修正で入った退行 — 根拠: scripts/acs-probe/AcsProbe.java:32、:77-91、scripts/README.md:732 [conv:-]
- [nit] 手順の検査が命令名と `${LIB}` だけで、引数の誤り（`sleep` の数値・`setcursor` の書式）はサインオン後に例外になり、SIGNOFF も通らない — 根拠: scripts/acs-probe/AcsProbe.java:99-112 [conv:-]
- [nit] JVM に渡す環境変数から `LC_ALL` / `LC_CTYPE` が落ちた。ロケールをそれで決める環境では、ASCII でないパスが使えない — 根拠: scripts/acs-probe.mjs:96-99 [conv:-]
- [nit] 利用者名を伏せる置換が大文字小文字を区別する。IBM i は利用者名を大文字で表示する — 根拠: scripts/acs-probe.mjs:112-113 [conv:-]
- [nit] `acs-probe.mjs` 自身も、環境・JDK・jar・コンパイルの失敗と java の時間切れで 2 を返す。README の「2 = 手順の誤り」と食い違い、JVM の起動失敗（1）も書いていない — 根拠: scripts/acs-probe.mjs:34-37、:121、scripts/README.md:732 [conv:-]
- [nit] `ECLField.SetString` は打鍵の経路を通らないので、欄の大文字化が掛からない可能性（推測）。930 の SBCS には英小文字が無い。利用者名は大文字にしておく — 根拠: scripts/acs-probe/AcsProbe.java:87-88 [conv:-]
- [nit] S4a で `cut()` の直後に `recovered()` をすぐ判定するので、ページが切断を反映する前に真になりうる。前提の確認が古いソケットを見て、偽の PASS（N19 が直ったように見える）になりうる（推測・低確率） — 根拠: scripts/verify-browser-reconnect.mjs:295-300 [conv:-]

## ラウンド 3（2026-09-20）

対象: ラウンド 2 の指摘を反映した `scripts/acs-probe.mjs`・`scripts/acs-probe/AcsProbe.java`・`scripts/verify-browser-reconnect.mjs`・README の節。
ラウンド 2 の直し（偽の合格を出さない）は正しく効いている。確かめたもの:
- `return` と `finally` の中の `System.exit`
- 既定値 4
- `escapeRe` と `gi` の伏せ字
- exit 1 / 5 の分け方
- S4a の `socketsOpened` と `recovered` の組み合わせ

**must 0・should 0・nit 8**（別コンテキストの点検と併用）。偽の合格になる経路は残っていない。

- [nit] 引数の検査は `strip()` した値を見るが、実行側は strip せずに `parseLong` する（`sleep  500` のような空白 2 つ）。桁あふれ・画面外の `setcursor` も、接続した後で落ちる（exit 4・SIGNOFF なし） — 根拠: scripts/acs-probe/AcsProbe.java:121-131、:187-199 [conv:-]
- [nit] `finally` の片付けの catch が `Exception` のまま。`StopCommunication` の `Error` で `System.exit(code)` に届かない（偽の合格にはならない） — 根拠: scripts/acs-probe/AcsProbe.java:216-222 [conv:-]
- [nit] サインオン画面の入力欄が見つからないときや、HACL が接続の失敗を例外で返すときは 4 になる（README の「3 = 接続できない・サインオンできない」と分類がずれる） — 根拠: scripts/acs-probe/AcsProbe.java:90、:209-213 [conv:-]
- [nit] `acs-probe.mjs` 自身の未捕捉の例外（`~/.cache` を作れない等）は Node の既定で 1 になり、「1 = JVM を起動できない」と読み違える — 根拠: scripts/acs-probe.mjs:65、:84、:90 [conv:-]
- [nit] サインオンの成否を「非表示の欄が残っていない」だけで見るので、切断されて空になった画面も成功と読みうる。手順の途中の切断も見ない（推測） — 根拠: scripts/acs-probe/AcsProbe.java:100-104、:184-208 [conv:-]
- [nit] S4a の前提（新しいソケット・ping 未受信）が FAIL でも、検出の判定へ進む。繋ぎ直しに失敗して「切断」のままだと、検出の行が PASS になりうる（全体は exit 1） — 根拠: scripts/verify-browser-reconnect.mjs:301-307 [conv:-]
- [nit] S4a の末尾の `cut()` の直後にも、同じ競合が残る（LAT の最初の標本に混ざりうる。推測・低確率） — 根拠: scripts/verify-browser-reconnect.mjs:308-309 [conv:-]
- [nit] コメントの「QPWDLVL 2/3 は 37 などで繋ぐこと（README）」に対応する記述が README に無い — 根拠: scripts/acs-probe/AcsProbe.java:91-93、scripts/README.md:727 [conv:-]
