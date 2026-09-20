# 仕様: backlog 全件の要否判定と ACS との差異の洗い出し

## 概要

research で出た判定と差異を、次の 3 つの成果物に落とす。

1. **台帳の更新**: 4 ファイル
   - 既存 16 件に判定を書き込む（閉じる・書き直す・割る）
   - 新しい差異を約 23 件起票する
2. **突き合わせ表** `acs-comparison.md`（この work のフォルダ）: AC5 の「突き合わせた領域の一覧」の実体。
   research は差異だけを載せ、組の一覧は委譲先の報告に留まっていたので、ここへ集約する。
3. **検証スクリプト 2 本**（`scripts/`）: ACS のコアを ECL で実機に当てるプローブと、ブラウザの瞬断を作る検証（decisions D8）。

製品コード（`packages/*`）は変えない。

## 設計方針

- **台帳の書式を 1 つに揃える**。判定の行・根拠・検証の深さ・出典を同じ形で書き、次に選ぶ人が項目どうしを比べられるようにする。
- **新しい差異は混合の粒度で起票する**（decisions D5）。
  - 1 件ずつ: 高と、中の ◎・○・◐
  - 領域ごとに 1 件へまとめる: △ と低
- **方針の判断が要るものは「要判断（方針）」と書いて残す**（decisions D6）。この work では決めない。
- **閉じる項目も消さない**。
  - `- [x]` にして判定の行を足す。
  - 事実と食い違う記述は取り消し線で残す（AGENTS.md「記録の同期」）。
- **検証スクリプトは、research で使ったものを `scripts/` の規約に合わせて整える**。新しい機能は足さない。

## 対象範囲

- 変更
  - `.aidev/backlog/session-lifecycle.md`
  - `.aidev/backlog/code-quality-checks.md`
  - `.aidev/backlog/acs-parity.md`
  - `.aidev/backlog/pc-command.md`
  - `scripts/README.md`（節を 2 つ追加）
- 追加
  - `.aidev/works/20260919-backlog-acs-triage/acs-comparison.md`
  - `scripts/acs-probe.mjs`（実行の口）
  - `scripts/acs-probe/AcsProbe.java`（ECL を呼ぶ本体）
  - `scripts/acs-probe/*.txt`（手順の例 2 本）
  - `scripts/verify-browser-reconnect.mjs`
- 変更しない: `packages/*`、`IBMiAccess_v1r1/`（`.git/info/exclude` 済み）

## 依拠する既存の事実

- **台帳の未着手行の位置**
  - `session-lifecycle.md:52, 58, 67, 70, 74, 84, 101, 107`
  - `code-quality-checks.md:9-12`
  - `acs-parity.md:33, 42, 44`（2 桁インデントの子項目）
  - `pc-command.md:70`
  - いずれも `grep -n '\- \[ \]'` で確かめた（research「実装アンカー」）。
- **`aidev status` はインデントした子項目も件数に数える。** 2026-09-19 の出力で `acs-parity.md` の todo が 3 だった。行頭の `- [ ]` は 0 件で、該当するのはインデント付きの 3 行なので、そう判断できる。
  AGENTS.md「記録の同期」には「インデントした子は件数に入らない」とあり、**現状と食い違う（未確認の差。台帳の件数検査は `aidev status` の実測で行う）**。
- **閉じるときの根拠の書き方**: AGENTS.md「記録の同期」に従う。works slug・PR 番号・リポジトリ内で裏が取れるもの（`file:line`・実測値）を書く。
- **scripts の規約**
  - `console.*` は lint で禁止（`eslint.config.js` の `no-console`。`scripts/` は ignores に入っていない）。
  - 既存のスクリプトは `process.stdout.write` を使い、`node --env-file=.env --env-file=.env.verify` で実行する（`scripts/README.md`「実行方法」、`scripts/diag-dspfmt-ws-e2e.mjs:1-30`）。
  - 実機の固有名は書かない（AGENTS.md「実機の識別子」）。
  - 実機に作ったものは片付ける（memory `realhost-verify-objects`）。
- **ブラウザ検証の土台**
  - `buildApp` / `SessionManager` / `ServerConfigStore` / `ConfigResolver` を in-process で立てる形が既にある（`scripts/verify-acs-display.mjs:58-77`）。
  - web-ui の要素
    - 起動画面: `.launcher`
    - OIA: `.oia`
    - 手動の再接続ボタン: `.fk.retry`（`packages/web-ui/src/components/StatusBar.vue:220-221`）
    - 応答待ちの覆い: `.busy-overlay`（`EmulatorPane.vue:1040`）
- **ECL プローブの API**（research F0-2 で実測）
  - `com.ibm.eNetwork.ECL.ECLSession(Properties)`
  - `StartCommunication()`
  - `ECLPS.SendKeys` / `GetScreen(char[], int, TEXT_PLANE)` / `GetCursorPos()`
  - `ECLOIA.InputInhibited()`
- **ACS の jar の置き場**: `IBMiAccess_v1r1/acsbundle.jar` の中の `plugins/emulator/acshod2.jar`（research F0-1）。

## インターフェース / データ構造

### 台帳の書式

**既存の項目を閉じるとき**（対応不要）

```markdown
- [x] <元の本文。事実と食い違う箇所は ~~取り消し線~~ で残す>
  **判定（`20260919-backlog-acs-triage`・PR #<deliver で追記>）: 対応不要（<区分>）** — <理由を 1〜2 文>。
  根拠: <file:line / 実測値 / ACS のクラス.メソッド>（research F1-<n>）。
```

- 区分は次の 3 つのどれか。
  - 解決済み
  - 差異なし・実害なし
  - 実害なし・回避策あり
- 継続行は 2 桁インデントの本文で書く。**チェックボックスを付けない**（子の項目にしない）。

**既存の項目を残すとき**（対応要）

```markdown
- [ ] <元の本文。食い違う箇所は ~~取り消し線~~>
  **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 <高|中|低>** — <現物で確かめた事実>。
  <食い違いがあれば: 起票時「…」→ 現状「…」>（research F1-<n>）。
```

**割るとき**（項目 2・8）: 済んだ分の `- [x]` と、残りの `- [ ]` を**兄弟として並べる**（AGENTS.md）。

**新しく起票するとき**

```markdown
- [ ] **<見出し>**（優先度 <高|中|低>・深さ <◎|○|◐|△>）。<何が起きるか・利用者から見た影響>。
  ACS: <クラス.メソッドと振る舞い>。当 PJ: <file:line と振る舞い>。再現: <条件 / 要実測ならその方法>。
  <要判断（方針）の項目: 選択肢 A / B と ACS の挙動>
  <△ の項目: **着手時に ACS 側・当 PJ 側の両方を再確認すること**（委譲先の読みのみ）>
  （出典: `20260919-backlog-acs-triage` research <N 番号 / F 番号>）
```

- ACS のコードは引き写さない。書くのは、クラス.メソッドと振る舞いを自分の言葉で言い直したものだけ。
- 実機の固有名は書かない。例えば「検証ライブラリ（`AS400_LIB`）の CURSORCL3」と書く。

### 既存 16 件の処置

| 台帳の行 | 項目 | 処置 | research |
|---|---|---|---|
| session-lifecycle:52 | 1 D19 | 残す・低 | F1-1 |
| session-lifecycle:58 | 2 D17 | **割る**: `[x]` `lifetimeOf`（回帰テストで覆われている）＋ `[ ]` `error` 経路・中 | F1-2a/2b |
| session-lifecycle:67 | 3 瞬断 | `[x]` 解決済み（S1〜S4b の実測値） | F2 |
| session-lifecycle:70 | 4 tab-visibility | 残す・低〜中。「単体実行では 8 件とも緑」に取り消し線を引く | F1-4 |
| session-lifecycle:74 | 5 onClose の門 | 残す・低（プリンターだけ。VT には到達しない） | F1-5 |
| session-lifecycle:84 | 6 はしご中のホスト終了 | `[x]` 差異なし・実害なし（到達しない）。PR #394 を閉じた旨も書く | F1-6 |
| session-lifecycle:101 | 7 openSession | 残す・中。範囲を VT・プリンターと `connecting` の固着に広げる | F1-7 |
| session-lifecycle:107 | 8 待たされる | **割る**: `[x]` 切り分け（平常時は健全・候補 4 つを起票）＋ `[ ]` 利用者に待たされた操作を確かめて候補を確定する・中 | F3 |
| code-quality-checks:9 | 9 JSDoc | 残す・中（55 件／約 52 件） | F1-9 |
| code-quality-checks:10 | 10 sharedFiles | `[x]` 実害なし（前提が崩れた）。起票時の 4 ファイルに取り消し線を引く | F1-10 |
| code-quality-checks:11 | 11 work 参照 | 残す・低。対象形を直す必要と、条項の例との矛盾を書く | F1-11 |
| code-quality-checks:12 | 12 網羅の主張 | `[x]` 実害なし（費用に見合わない） | F1-12 |
| acs-parity:33 | 13 DSPATR(CS) | `[x]` 差異なし | F1-13 |
| acs-parity:42 | 14 CURSORCL3 | `[x]` 差異なし（実測で一致） | F1-14 |
| acs-parity:44 | 15 ヒューリスティック | `[x]` 解決済み／具体的な対象なし。「ACS の起動が必要」に取り消し線を引く | F1-15 |
| pc-command:70 | 16 CALL START | `[x]` 実害なし・回避策あり | F1-16 |

### 新しく起票する項目

**acs-parity.md の末尾に追加（19 件）**

| # | 見出し（要旨） | 優先度 | 深さ | research |
|---|---|---|---|---|
| 1 | RESTORE SCREEN で自分の退避イメージを再適用し、打鍵と MDT が消える | 高 | ◎ | N1（N7 の `writeCell` を含む） |
| 2 | 挿入モードで、あふれた末尾を黙って捨てる／符号付き数値が化ける | 高 | ○ | N2 |
| 3 | 施錠中・応答待ち中の先打ちを捨てる（**要判断（方針）**） | 高 | ◐ | N3 |
| 4 | DBCS プリンターの申告（5553-B01 と送る 6 変数）が ACS と違う（**要実測**） | 高 | △ | N4 |
| 5 | CC1=0xC0 で、MDT の立った欄を消さない（順序が逆） | 中 | ○ | N5 |
| 6 | READ だけのレコードで、カーソルを先頭の入力欄へ動かす | 中 | ○ | N6 |
| 7 | Erase Input が中身のある全欄を消す（ACS は MDT の欄だけ・カーソルはホームへ） | 中 | ○ | N7 |
| 8 | 挿入モードが画面をまたいで残る | 中 | ○ | N8 |
| 9 | Shift+Enter で送信する（ACS は Newline） | 中 | ○ | N9 |
| 10 | 起動応答コード 2703/2777/8936/8937 が無い | 中 | ○ | N10 |
| 11 | WEC を窓の中に描かない／エラー状態が明けてもメッセージ行を戻さない | 中 | ◐ | N11 |
| 12 | メッセージ待ち表示（MW）を出さない | 中 | ◐ | N12 |
| 13 | プリンター: 受信した瞬間に印刷完了を返す／CLEAR に応答しない | 中 | ◐ | N15 |
| 14 | READ の無いアンロックで応答待ちが解けない（#401 以降。**要実測**） | 低〜中 | ◐ | F3-3 H |
| 15 | ホストに切られた後の自動再接続（**要判断（方針）**） | 中 | △ | N18 |
| 16 | 【まとめ】キー編集の細部（RB/RZ の FER・0020・Home・Backtab・ME の意味・テンキーの ±・L 群。Home/ME は**要判断（方針）**） | 中〜低 | △ | N13・F5 |
| 17 | 【まとめ】DS5250 のその他（画面イメージ応答の形式・ROLL・CLEAR の付随処理・WSF D9/72・WDSF 52/54/55・負応答・Help/Clear/Print の欄データ・WEA タイプ 5） | 低 | △（WEA タイプ 5 は ○） | N14・低 |
| 18 | 【まとめ】telnet・自動サインオン（IBMRSEED の書式・装置名の正規化と再試行の理由・1399 の申告・端末タイプ・関連プリンター・交渉前のテキスト・拒否理由の言語） | 中〜低 | △（IBMRSEED は ◐） | N17・低 |
| 19 | 【まとめ】SCS（制御の対応範囲・0x2B の消費長・SO/SI の桁・重ね打ち・書式オーダー・ジョブ終了の判定） | 中〜低 | △ | N16・低 |

**session-lifecycle.md の末尾に追加（3 件。項目 8 を割った残りの 1 件は上の表で扱う）**

| # | 見出し（要旨） | 優先度 | 深さ | research |
|---|---|---|---|---|
| S1 | リロード・タブを閉じた後、90 秒は同じ装置名で開けない（`8902`）。ACS はウィンドウを閉じると接続も閉じる | 高 | ◎ | F3-3 D |
| S2 | ping の見張りが最初の ping を受けるまで張られない（開いてから約 30 秒の半開きを検出できない） | 中 | ◎ | N19 |
| S3 | プリンターの「＋新規」で、古い口がリークし、`detachReport` が新しい接続の購読を外しうる | 低 | △ | F1-5 |

**件数の見込み**（この work の後の `aidev status` の todo）

| ファイル | 見込み |
|---|---|
| session-lifecycle | 9（残す 4 ＋ 割った残り 2 ＋ 新規 3） |
| code-quality-checks | 2 |
| acs-parity | 19 |
| pc-command | 0 |

### 突き合わせ表 `acs-comparison.md`

- 領域 3 つ（DS5250 の WTD 以外 / キー入力・編集・AID・施錠 / telnet・プリンター）ごとに、表を 1 つ作る。
  列は「ACS 側（クラス.メソッド）｜当 PJ 側（`file:line`）｜結果（一致 / 差異あり→台帳の # / 未対応 / 意図的な差異 / 対象外とした理由）｜深さ」。
- 冒頭に、**対象外とした領域**（既に突き合わせ済みの 5 領域・TN3270・VT）と、その理由を書く。
- 出典は委譲先 C・D・E の報告と、主エージェントの確認（research F4）。

### `scripts/acs-probe.mjs` ＋ `scripts/acs-probe/AcsProbe.java`

- **目的**: ACS のコア（HACL/ECL）を GUI 無しで実機に当て、手順どおりに打鍵して、ACS 側の画面・カーソル・入力禁止の状態を出す。当 PJ と ACS の挙動を並べるのに使う。
- **実行**: `node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs <手順ファイル> [AS400|PUB400]`
- **入力**（環境変数）
  - `<PREFIX>_HOST` / `_USER` / `_PASSWORD`（`.env`）
  - `<PREFIX>_LIB`（`.env.verify`。手順の中の `${LIB}` に差し込む）
  - `ACS_JAR`（既定はリポジトリ直下の `IBMiAccess_v1r1/acsbundle.jar`）
  - `PROBE_CODEPAGE`（既定 `930`）
  - `PROBE_SCREEN`（`24x80` → `"2"` / `27x132` → `"5"`）
  - `PROBE_DEVNAME`（任意）
- **処理**
  1. `os.tmpdir()/ts5250-acs-probe/` に、`acsbundle.jar` から `plugins/emulator/acshod2.jar` を取り出す（JDK の `jar xf`）。元より古いときだけ取り出し直す。
  2. `AcsProbe.java` を同じ場所へ `javac` する。
  3. `java -Djava.awt.headless=true` で実行する。資格情報は環境変数で渡し、引数に載せない。
  4. 出力からパスワードとホストの値を伏せてから流す。
- **手順ファイルの文法**（1 行 1 命令。`#` はコメント）

  | 命令 | 意味 |
  |---|---|
  | `signon` | サインオン画面で利用者名と Tab とパスワードを打ち、Enter を押す |
  | `keys <文字列>` | `ECLPS.SendKeys` にそのまま渡す（`[enter]` `[attn]` `[pf12]` など） |
  | `settle [ms]` | 入力禁止が解けるまで待ち、さらに ms 待つ |
  | `sleep <ms>` | 待つ |
  | `setcursor <行>,<桁>` | カーソルを置く |
  | `dump [ラベル]` | 空でない行・カーソル・入力禁止の状態を出す |

- **手順の例**
  - `scripts/acs-probe/attn-restore.txt`（N1: コマンド行に打つ → Attn → F12 → dump）
  - `scripts/acs-probe/cursorcl3.txt`（項目 14: `CALL ${LIB}/CURSORCL3`）
  - どちらも最後に `SIGNOFF` する。
- **リポジトリに入れないもの**: ACS の jar と、そこから取り出したもの（tmpdir にだけ置く）。

### `scripts/verify-browser-reconnect.mjs`

- **目的**: 実機・実ブラウザで、接続の寿命（瞬断・はしご・手動の再接続・半開き）と、打鍵から画面反映までの時間を測る。
- **実行**: `node --env-file=.env --env-file=.env.verify scripts/verify-browser-reconnect.mjs [S1 S2 S3 S4 S4a LAT]`
  - 既定は `S1 S2 S3 S4 LAT`。
  - `S4a` は N19 を再現する手順。**直るまで NG が正しい結果**なので、既定からは外す。
- **構成**
  - in-process のサーバー（`verify-acs-display.mjs` と同じ形）を立てる。
  - ブラウザとサーバーの間に TCP 中継を挟む。中継の状態は次の 3 つ。
    - `pass`: 通す
    - `refuse`: 新しい接続を RST で断る
    - `blackhole`: 黙って止める
  - `cut()` で、生きている口を RST で落とす。
  - 装置名は指定しない（ホストに採らせる）。
- **時刻**: `page.addInitScript` で WebSocket と DOM に、ページ内の時計（`performance.now()`）で印を打つ。Playwright の `framesent` / `framereceived` は使わない（CDP の遅れがある。research F0-4）。
- **判定**（`OK` / `NG` を 1 行ずつ出す。NG が 1 つでもあれば exit 1）

  | シナリオ | 判定 |
  |---|---|
  | S1 | 3 秒の断の後、30 秒以内に同じ画面へ戻り、F3 がホストに通る |
  | S2 | 応答待ちの最中に 3 秒の断が入っても、最新の画面に戻り、応答待ちが解ける |
  | S3 | 40 秒の断で「再接続」ボタン（`.fk.retry`）が出る。回線を戻して押すと戻る |
  | S4 | 最初の ping を受けてから黙って止めると、`PING_DEAD_MS`＋保険（約 93 秒）で再接続中になり、戻る |
  | S4a | ping を受ける前に黙って止めると、130 秒以内に再接続中になる（**N19 が直るまで NG**） |
  | LAT | 15 往復の、打鍵→描画の p50 / p90 と、打鍵→screen の中央値を出す（判定はしない。基準線として記録） |

- **後始末**: 最後に `SIGNOFF` を送る。一時の設定ファイルは `mkdtemp` に置く。

### `scripts/README.md`

「他クライアントの実測（tap-proxy）」の節の後ろに、2 つの節を足す。

- 「ACS のコアを直接動かす（ECL プローブ）」
  - 何が取れるか（コアのみ。GUI の経路は取れない）
  - jar の置き場と、コミットしないこと
  - 手順の文法
  - 実績（CURSORCL3・Attn→F12）
- 「接続の寿命の実ブラウザ検証（瞬断・半開き）」
  - シナリオの表
  - S4a が N19 の再現であること
  - 負荷の高いときの計測は信用しないこと（decisions D4）

## 振る舞いの詳細

- 台帳を書き換える順序: 既存 16 件の処置 → 新規の起票 → `aidev status` で件数を照合。
- 取り消し線を引くのは、**事実の主張だけ**（AGENTS.md「記録の同期」）。手法や経緯の記述は残す。
- 閉じる項目の PR 番号は、deliver で追記する（coding の時点では `PR #<deliver で追記>` の目印を置く）。

## ドメイン固有の考慮

- **ACS は IBM の頒布物**。
  - 台帳・突き合わせ表・スクリプトに、ACS のコードを逐語で書かない。
  - スクリプトは HACL の公開 API を呼ぶだけの自作コードで、jar は利用者の手元のものを指す（AGENTS.md「ライセンスと出典」）。
- **「規格どおり」より「既存クライアントと同じ挙動」を優先する**（AGENTS.md）。新しい差異の優先度はこの基準で付けた。
- 意図的な差異として記録があるものは、その旨を書いて区別する。例:
  - Enter のときだけ必須検証をする（`20260729-ffw-behavior-bits` D1）
  - 操作員エラーで打鍵を止めない（`opMessages.ts`）

## エラー処理 / 異常系

- **ACS の jar が無い**: 探した場所を示して終了する（exit 2）。
- **`jar` / `javac` が無い**: JDK が要ることを示して終了する（exit 2）。
- **資格情報が無い**: 既存のスクリプトと同じ文言で終了する（exit 2）。
- **サインオンで止まる**（自動サインオンが効かない実機）: 両スクリプトとも、サインオン画面では入力欄に打ち込み、「サインオン情報」画面では Enter を押す。
  - サインオン画面は「利用者名とパスワードの入力欄がある」ことで判定する。「パスワード」という語だけで判定すると、サインオン情報の画面（「F9=パスワードの変更」）を取り違える（research で実際に踏んだ）。
- **装置が使用中**: 装置名を指定しないので起きない。`PROBE_DEVNAME` を指定したときは、`8902` をそのまま表示する。

## 受け入れ基準との対応

- AC1: 「既存 16 件の処置」の全行に判定の行を書く。入力は research F1 の表と各 F1-n、F2、F3。
- AC2: 判定の根拠は research F1 の `file:line`・テストの実行結果・実測値だけを使う。起票時と食い違う記述（項目 4・10・11・15、項目 6 の前提、項目 7 の範囲）は取り消し線と「起票時→現状」で書く。入力は research F1 の「食い違い」。
- AC3: 実測した項目（3・8・14）は値を書く。実測しなかった項目は理由を書く。
  - 項目 13: 表が一致するので、判定に要らない
  - 新規 4・14 など: 「要実測」と測り方
  - 入力は research F2・F3・F1-13・F4。
- AC4: 項目 9〜12 に、現在の数字（55 件／52 件、doctor の 2 件、87 行、2,186 行）を書く。入力は research F1-9〜F1-12。
- AC5: `acs-comparison.md` に、3 領域の組を「ACS 側｜当 PJ 側｜結果｜深さ」の表で置く。入力は委譲先 C・D・E の組の一覧（research F4 の出典）。
- AC6: 新規の 22 件（acs-parity 19・session-lifecycle 3）に、影響（どの操作で、どう見えるか）と判定（優先度）を書く。入力は research F4・F3。
- AC7: 新規の全項目に深さ（◎ ○ ◐ △）を書く。△ には「着手時に両側を再確認」を添える。入力は research の深さの表記。
- AC8: 台帳を書式どおりに更新し、`aidev status` の todo が「件数の見込み」と一致することを確かめる。割った項目は兄弟として並べる。
- AC9: coding の完了時に次を確かめる。
  - `git diff --stat -- packages` が空
  - 実機の識別子（`.env` と `.env.verify` の値）の走査が 0 件
  - `IBMiAccess_v1r1/` と ACS から取り出したものが追跡対象に無い
  - 秘密の走査が 0 件
  - 実機に作った検証物は無い（既存の CURSORCL3 を使っただけ）。スクリプトは最後に `SIGNOFF` する。
