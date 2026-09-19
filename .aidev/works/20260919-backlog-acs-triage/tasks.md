# タスク: backlog 全件の要否判定と ACS との差異の洗い出し

## 実装方針

design の成果物 3 つを、次の順で作る。

1. 台帳の既存 16 件の処置
2. 新規の起票
3. 突き合わせ表
4. 検証スクリプト 2 本と README
5. 実機での 1 回ずつの通し
6. 自己点検

- 台帳は、design「台帳の書式」と「既存 16 件の処置」「新しく起票する項目」の表どおりに書く。判定の中身は research F1〜F4 から取り、新しい調査はしない。
- スクリプトは research で使った scratchpad の版（`probe/blink.mjs`・`acs/probe/AcsProbe.java`）を元に、design の仕様へ整える。新しい機能は足さない。

## 作業順序と依存関係

- 下の `依存:` に従う。
- 同じファイル（`acs-parity.md` / `session-lifecycle.md`）に触るタスクは、`依存:` で直列にしてある。**同じファイルを並行して書き換えない**ため。

## リスク / 留意点

- **台帳に実機の固有名や ACS のコードを持ち込む。**
  - research の本文から写すと混ざりうる。T11 で `.env` / `.env.verify` の値の走査と、目視の確認をする。
- **取り消し線の付け過ぎ。**
  - 取り消すのは事実の主張だけ。経緯や手法の記述は残す（AGENTS.md「記録の同期」）。
- **件数の食い違い。**
  - 割った項目を子（インデント＋チェックボックス）にすると、兄弟にならない。`aidev status` の件数で確かめる。
- **スクリプトの `console.*`。**
  - lint で落ちる。`process.stdout.write` を使う。
- **実機での通しが装置を掴む。**
  - 装置名は指定しない。最後に `SIGNOFF` を送る。途中で止めたときは、リトライ待ちを見込む（AGENTS.md「ビルド・テスト」）。

## テスト方針

test 工程で次を確かめる。

- **AC1・AC2**
  - 16 件の台帳上の行に、判定の行（`**判定（\`20260919-backlog-acs-triage\`…`）があるか（grep）。
  - 根拠に `file:line` / 実測値 / ACS のクラス.メソッドが入っているか。
- **AC3**
  - 実測した項目（3・8・14）に値が入っているか。
  - 実測しなかった項目に、理由または「要実測」と測り方が入っているか。
- **AC4**: 項目 9〜12 に、現在の数字が入っているか。
- **AC5**: `acs-comparison.md` に、3 領域の表と「対象外とした領域」の節があるか。
- **AC6・AC7**: 新規の 22 件すべてに、影響・優先度・深さがあるか。△ に再確認の注記があるか。
- **AC8**: `aidev status` の todo が、design「件数の見込み」（9 / 2 / 19 / 0）と一致するか。
- **AC9**
  - `git diff --stat -- packages` が空か。
  - 実機の識別子の走査が 0 件か。
  - ACS のファイルが追跡対象に無いか。
  - 秘密の走査が 0 件か。
  - スクリプトの lint（`npx eslint scripts/acs-probe.mjs scripts/verify-browser-reconnect.mjs`）が通るか。
- **スクリプトの動作**: T10 の実機での通しの記録を、test-result.md に写す。

## タスク

- [x] T1: session-lifecycle.md の既存 8 件を処置する
  - 項目 3・6 を閉じる。
  - 項目 2・8 を割る（兄弟として並べる）。
  - 項目 1・4・5・7 に判定の行を足し、食い違いに取り消し線を引く。
  - 閉じる行には `PR #<deliver で追記>` の目印を置く。
      対象: `.aidev/backlog/session-lifecycle.md:52, 58, 67, 70, 74, 84, 101, 107` / 根拠: research A1・F1・F2・F3、design「既存 16 件の処置」
      依存: なし
      AC: AC1, AC2, AC3, AC8
- [x] T2: code-quality-checks.md の既存 4 件を処置する
  - 10・12 を閉じる。
  - 9・11 に判定の行と現在の数字を足す。
  - 10 の起票時の 4 ファイルに取り消し線を引く。
      対象: `.aidev/backlog/code-quality-checks.md:9-12` / 根拠: research A2・F1-9〜F1-12
      依存: なし
      AC: AC1, AC2, AC4, AC8
- [x] T3: acs-parity.md の既存 3 件（子項目）と pc-command.md の 1 件を閉じる
  - 項目 15 の「ACS の起動が必要」に取り消し線を引く。
  - 項目 14 に CURSORCL3 の実測値（両者とも 3 行 12 桁）を書く。
      対象: `.aidev/backlog/acs-parity.md:33, 42, 44`、`.aidev/backlog/pc-command.md:70` / 根拠: research A3・A4・F1-13〜F1-16
      依存: なし
      AC: AC1, AC2, AC3, AC8
- [x] T4: acs-parity.md の末尾に新しい差異 19 件を起票する
  - 表の 1〜19。design「新しく起票する項目」の書式どおりに書く。
  - 要判断（方針）は 3・15・16、要実測は 4・14。
      対象: `.aidev/backlog/acs-parity.md`（末尾） / 根拠: research A5・F4・F3-3、design「新しく起票する項目」
      依存: T3
      AC: AC3, AC6, AC7, AC8
- [x] T5: session-lifecycle.md の末尾に新規 3 件（S1〜S3）を起票する
      対象: `.aidev/backlog/session-lifecycle.md`（末尾） / 根拠: research A5・F3-3 D・N19・F1-5
      依存: T1
      AC: AC6, AC7, AC8
- [x] T6: 突き合わせ表 `acs-comparison.md` を作る
  - 3 領域の表と「対象外とした領域」の節を置く。
  - 差異には台帳の # を振る。
      対象: `.aidev/works/20260919-backlog-acs-triage/acs-comparison.md`（新規作成） / 根拠: research F4（委譲先 C・D・E の組の一覧）、design「突き合わせ表」
      依存: T4
      AC: AC5, AC7
- [x] T7: ECL プローブを `scripts/` に置く
  - 置くもの: `scripts/acs-probe.mjs`、`scripts/acs-probe/AcsProbe.java`、手順の例 2 本（`attn-restore.txt` / `cursorcl3.txt`）
  - design の仕様どおりに書く（jar の取り出しは tmpdir・資格情報は環境変数・出力を伏せる）。
      対象: `scripts/acs-probe.mjs`・`scripts/acs-probe/`（新規作成） / 根拠: design「`scripts/acs-probe.mjs` ＋ `AcsProbe.java`」、scratchpad の `acs/probe/AcsProbe.java`・`run.js`
      依存: なし
      AC: なし
- [x] T8: `scripts/verify-browser-reconnect.mjs` を置く
  - シナリオ: S1・S2・S3・S4・S4a・LAT
  - OK/NG で判定し、NG があれば exit 1。S4a は既定の実行から外す。
      対象: `scripts/verify-browser-reconnect.mjs`（新規作成） / 根拠: design「`scripts/verify-browser-reconnect.mjs`」、scratchpad の `probe/blink.mjs`、`scripts/verify-acs-display.mjs:58-77`
      依存: なし
      AC: なし
- [x] T9: `scripts/README.md` に 2 節を足す
  - 足す場所: 「他クライアントの実測（tap-proxy）」の後ろ
  - 節: ECL プローブ、接続の寿命の実ブラウザ検証
      対象: `scripts/README.md:593`（tap-proxy の節の後ろ） / 根拠: design「`scripts/README.md`」
      依存: T7, T8
      AC: なし
- [x] T10: 実機で 1 回ずつ通す
  - 通すもの
    - acs-probe の `attn-restore.txt` と `cursorcl3.txt`
    - verify-browser-reconnect の既定シナリオ（S1 S2 S3 S4 LAT）
  - 結果を test-result の素材として控える。
      対象: `scripts/acs-probe.mjs`・`scripts/verify-browser-reconnect.mjs` / 根拠: T7・T8
      依存: T7, T8
      AC: AC9
- [x] T11: 自己点検
  - `aidev status` の件数の照合（9 / 2 / 19 / 0）
  - `git diff --stat -- packages` が空であること
  - 実機の識別子・秘密の走査
  - ACS のファイルが追跡対象に無いこと
  - スクリプトの eslint
      対象: 台帳 4 ファイル・`scripts/` の新規ファイル・この work のフォルダ / 根拠: design「受け入れ基準との対応」AC8・AC9
      依存: T1, T2, T3, T4, T5, T6, T9, T10
      AC: AC8, AC9
- [x] T12: review ラウンド 1 のスクリプトへの指摘を反映する
  - `verify-browser-reconnect.mjs`: 127.0.0.1 で待ち受ける／S4・S4a の ping 判定を、最後に開いたソケットに限る／S2 の判定を直す／シナリオ名を検証する／後始末と記録の整理
  - `AcsProbe.java`: 接続の確認・try/finally・欄への直接入力でのサインオン・UTF-8 出力・PUB400 の既定コードページ
  - `acs-probe.mjs`: 利用者ごとの作業ディレクトリ・渡す環境変数を最小に・利用者名も伏せる・`jar xf` の前に消す・PUB400_HOST の既定
      対象: `scripts/verify-browser-reconnect.mjs`・`scripts/acs-probe/AcsProbe.java`・`scripts/acs-probe.mjs` / 根拠: review.md ラウンド 1
      依存: なし
      AC: AC9
- [x] T13: `.gitignore` に `IBMiAccess_v1r1/` を足し、README（JDK の版・PUB400 のコードページ・S4 の値と呼び名）と台帳の P2（AGENTS.md 残課題への参照）を直す
      対象: `.gitignore`・`scripts/README.md`・`.aidev/backlog/acs-parity.md` の P2 / 根拠: review.md ラウンド 1
      依存: なし
      AC: AC9
- [x] T14: 直したスクリプトを実機で通し直す（acs-probe の 2 手順、verify-browser-reconnect の既定＋S4a）
      対象: `scripts/acs-probe.mjs`・`scripts/verify-browser-reconnect.mjs` / 根拠: T12
      依存: T12, T13
      AC: AC9
- [x] T15: review ラウンド 2 の指摘を反映する。不変条件「最後まで正しく流れたときだけ成功を返す」を支える箇所をすべて直す
  - `AcsProbe.java`: `Throwable` まで拾う。サインオンの成否を確かめる（パスワード欄が残っていたら 3 で止め、続きを打たない）。手順の引数を接続前に検査する。利用者名を大文字にする
  - `acs-probe.mjs`: `LC_ALL` / `LC_CTYPE` を渡す。利用者名は大文字小文字を問わずに伏せる。時間切れ（5）と JVM の起動失敗（1）を手順の誤り（2）と分ける
  - `verify-browser-reconnect.mjs`: S4a で、新しいソケットが開くのを待ってから前提を確かめる
  - README の終了コードの一覧
      対象: `scripts/acs-probe/AcsProbe.java`・`scripts/acs-probe.mjs`・`scripts/verify-browser-reconnect.mjs`・`scripts/README.md` / 根拠: review.md ラウンド 2
      依存: なし
      AC: AC9
- [x] T16: 直したスクリプトを実機と異常系で通し直す（誤ったパスワードで試す場合は 1 回だけにする。QMAXSIGN を消費するため）
      対象: `scripts/acs-probe.mjs`・`scripts/verify-browser-reconnect.mjs` / 根拠: T15
      依存: T15
      AC: AC9
