---
backlog: acs-parity
kind: standing
priority: 3
---

# ACS（IBM i Access Client Solutions）との仕様整合

ACS 実体（`acsbundle.jar`）がユーザーから提供され、コアクラス（`com.ibm.eNetwork.ECL.tn5250.*`
の `DS5250`/`PS5250` 等）をデコンパイルして参照できるようになった
（`20260914-seu-page-cursor-hold` decisions.md D6）。当プロジェクト独自の推測・
ヒューリスティックで実装していた挙動を、ACS の実装と突き合わせて是正する取り組み全般をここに置く。

<!-- 項目は行頭の `- [ ]` で書く（見出しに書くと aidev status の未着手件数から漏れる） -->
- [x] DSPFMT でフィールドのオプション入力欄の下線が消えたり、罫線のみ表示されることがある（利用者報告、20260915）のうち、**5250 拡張属性オーダー WEA（0x12）が未実装で WTD 内の以降の全オーダーが失われる欠陥**を修正した（`20260914-dspfmt-field-underline-instability`、`packages/tn5250/src/protocol/wtd-applier.ts` の `ORDER.WEA` case 追加、回帰テスト `packages/tn5250/test/wtd-applier.test.ts` 588件中1件）。ただし利用者の報告した具体的な症状の再現には至っていない（実機トレースでは WRKOBJPDM の Opt 欄 + F1ヘルプ窓開閉 + PageDown で0件、WEAも一度も出現せず）。残作業は下記に割る。
  - [x] ~~DSPFMT そのものの再現・原因特定は未達のまま~~——利用者からの新しい再現手順
    （`DSPFMT FILE(ASAOLIB/COMPLIST) OUTPUT(*)` を直接コマンド入力、スクリーンショット添付、
    20260915）を受けて再挑戦した結果（`20260915-dspfmt-reconnect-blank-redraw`）、
    再現・原因特定に成功した。**原因は `packages/tn5250/src/session/session.ts` の
    `handleRecord()` が `pendingAid`（`sendAid()` の Promise、`key-done` メッセージの元）を
    「`unlockKeyboard`（WCC のキーボード解放ビット）が立った最初のレコード」で解決していた
    こと**——DSPFMT の応答は3レコードに分かれ、1・2番目は unlock のみ・Read コマンド無し
    （骨格だけ）、3番目だけが Read 付き（実データ）だったため、骨格だけの画面で
    確定してしまっていた（実機トレースで確認、コア層単体・フレッシュな接続で8/8決定的に
    再現）。修正: 解決条件を `unlockKeyboard` から `readRequested`（実際に Read が
    要求されたか）に変更した（ローカル変数 `unlocked`→`readSolicited`）。実機診断
    （`scripts/diag-dspfmt-reconnect-blank.mjs`・`scripts/diag-dspfmt-ws-e2e.mjs`）で
    それぞれ8/8の解消を確認、回帰テスト
    `packages/tn5250/test/pending-aid-multi-record.test.ts`（3件）追加、既存テスト
    589件+2035件（web-ui、1件は無関係な環境依存flaky）に回帰無し。（出典:
    `.aidev/works/20260915-dspfmt-reconnect-blank-redraw/research.md`, `decisions.md`,
    `test-result.md`）
  - [x] 黄・青緑以外の色での桁区切り(DSPATR(CS))の実際の送信経路（WEA経由か等）は
    引き続き未確認のまま（`20260914-dspfmt-field-underline-instability` decisions.md D1）。
    実機に RPG コンパイル用のソースファイル（`QRPGLESRC`）が現在ASAOLIBに無く、実行時の
    確認ができなかった（DDSコンパイル自体は全7色で通ることは確認済み、
    `build-colsep-matrix.mjs`）。次はソースファイルの整備可否を利用者に確認するか、
    利用者の実機で直接トレースを取ることから始める。（出典:
    .aidev/works/20260914-dspfmt-field-underline-instability/research.md, decisions.md）
    **判定（`20260919-backlog-acs-triage`・PR #406）: 対応不要（差異なし・実害なし）** — 送信経路がどちらでも、表示は ACS と同じになる。
    - ACS が桁区切りを決めるのは属性バイトだけ（`PS5250.setAttributeToPlanes`）。立つのは 0x30〜0x37 と 0x3F で、
      当 PJ の `packages/tn5250/src/screen/attributes.ts:61-76` と 1 対 1 で一致する（#405 で揃えた）。
    - ACS の WEA の処理（`PS5250.writeExtAttribute`）が扱うのは、タイプ 5（DBCS の拡張 NLS 区間。DBCS セッションのみ）だけ。
      それ以外はセンスコードで拒否するので、**色や桁区切りを WEA で受ける経路は ACS に無い**。
    - Query Reply は ACS の実測値と一致させてある（`protocol/query-reply.ts`）ので、ホストは両者に同じものを送る。
    したがって、`QRPGLESRC` の整備も実機での実測も、判定には要らない。
    WEA タイプ 5 を当 PJ が無視している差は、新規の項目（DS5250 のその他）に入れた。（research F1-13）
- [x] ~~SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を維持する~~、という当初のAC1/AC2/AC8の目標（20260914-seu-page-cursor-hold で撤去済み）。~~ACS のコア（DS5250/PS5250）には専用ロジックが見当たらなかったため、UI描画層の調査や実機同時比較（tap-proxy.mjs等）で「ACSが実際にどう見せているか」を先に確定してから再挑戦する。~~ ——利用者からの新規報告（保護欄にカーソルを置いたまま PageUp/PageDown するとヘッダーの入力可能エリアへ強制移動する、ACSは変わらない）を受けて再調査した結果（`20260915-pdm-protected-cursor-pageup`）、上記の前提は2点とも誤りだったと判明した。(1) 症状は境界ページに限定されない（実機トレースで非境界ページでも再現、`research.md` F4/F5）。(2) 原因は ACS 側の未知ロジックではなく、**当プロジェクト既存の分岐（PR#387、`cursorAddr === cursorBefore && cursorIsUnenterable()` → 先頭入力欄へ寄せる）が PageUp/PageDown 応答で誤発火していたこと**——ACS の UI層調査は不要だった。~~修正: `lastSentAid`（直前に送信したAIDキー）を再導入し、PageUp/PageDown の応答でのみ既存2分岐（`PR#387`分岐・`!cursorSet`分岐）を除外する（`decisions.md` D2-D4）。~~ ~~訂正（deliver後、利用者指摘を受けた再検証。`decisions.md` D5）: AIDキー種別による判定は、たまたま検証した2ケースの相関にすぎず真の判別軸ではなかった。ACSのデコンパイル済みコアにキー種別による分岐は無く（`20260914-seu-page-cursor-hold` decisions.md D6）、真の判別軸は「このレコードを当てる前、その桁は入力可能だったか」（`cursorBeforeWasEnterable`）だった——`PR#387`分岐にのみこの条件を追加し、`!cursorSet`分岐は無条件（元の形）に戻した。`lastSentAid`は撤去。~~ **再訂正（`20260915-pr387-acs-premise-unverified`）**: `cursorBeforeWasEnterable` 自体も撤去された——`PR#387`分岐そのものが、未検証の前提（「ACSは下の入力欄にカーソルを入れる」）に基づいていたと判明し、分岐ごと撤去したため（下記の新規項目を参照）。結果として、SEU の PageUp/PageDown の症状はこの分岐撤去の副産物として解消された（`cursorBeforeWasEnterable` という条件分岐を経由せず、単純にホストのIC/MC指定に常に従う形になったため）。修正後のビルドで実機（SR-OSAKA/ASAOLIB）の境界・非境界両ケース（SEU）と`PR#387`元シナリオ（CURSORCL3、`PGM=CURSORCL3`）の両方でカーソル位置が正しく判定されることを確認済み（`.aidev/works/20260915-pr387-acs-premise-unverified/research.md` に実機再確認の記録あり）。回帰テスト: `packages/tn5250/test/cursor-stale-on-protected.test.ts`。（出典: `.aidev/works/20260915-pdm-protected-cursor-pageup/research.md`, `decisions.md`、`.aidev/works/20260915-pr387-acs-premise-unverified/research.md`, `decisions.md`）
- [x] **`PR#387`（コミット `c82e2b34`、保護欄でEnter確定後にカーソルを先頭入力欄へ寄せる、既にmainにマージ済み）の前提が未検証だったと判明し、分岐を撤去した**（`20260915-pr387-acs-premise-unverified`）。利用者から「ホストが位置を送ってくるならキー種別に関係なくホストに従えば良いのでは。ACSのjarにキー判定があるのか」との指摘、続いて「CURSORCL3でACSが下の入力欄へ寄せる、というのはこちらの報告だったか？誤報告かもしれない」との指摘を受けて調査した。判明した事実: (1) `PR#387`（GitHub PR #387）の検証資材は全てこのプロジェクト自身のクライアントが対象で、実際のACSソフトウェアには一度も接続していない。(2) PR本文の確認チェックリスト「報告された実際の画面で、Enter後に下の入力欄へ入ること」が未チェックのまま残っていた。(3) ACSのデコンパイル済みコア（`DS5250.preprocessWCC2()`）の全文を読んだ結果、カーソル位置の決定はIC/MCの有無だけで完結しており（GUI選択ウィジェット専用の狭い例外を除く）、この上書きに相当するロジックは存在しなかった。(4) 利用者自身も「当時ACSと比較した記憶は不確か」と回答。対応: `handleRecord()`から`PR#387`分岐と専用ヘルパー（`buffer.ts`の`isEnterableAt`/`cursorIsUnenterable`）を削除し、ACSコアの確認済み挙動（IC/MCの指定に常に従う）に一致させた。これにより、`PR#387`が元々解決しようとした症状（Enter確定後、保護化された欄にカーソルが取り残されTabを押すまで入力できない）は再び起きる——ACSコアの確認済み挙動に合わせるための意図的な変更であり、単純な退行ではないが、**実機ACSによる直接確認はこの work でも引き続きできていない**（~~この開発環境にACSが無いため~~ ——訂正（2026-09-17）: 誤り。下の子項目の訂正を参照）。もし将来、実機同時比較で「ACSは実際にCURSORCL3で下の欄へ寄せる」ことが確認された場合は、この変更を差し戻し、真の判別軸を実機で確認した上で`PR#387`相当の分岐を再実装する必要がある。（出典: `.aidev/works/20260915-pr387-acs-premise-unverified/research.md`, `decisions.md`）
  - [x] **実機ACSによる直接比較が今後も課題として残る**（~~利用者の協力が前提。~~`tap-proxy.mjs`等での実機同時比較）。特にCURSORCL3のシナリオ（Enter確定後の保護化）でACSが実際にどう振る舞うかは、今回も確認できていない。（出典: `.aidev/works/20260915-pr387-acs-premise-unverified/decisions.md` D2）**訂正（2026-09-17）**: 「この開発環境にACSが無い」は誤りで、ACSのjar（`acshod2.jar`）をそのまま使う 5250-operator MCP と `scripts/tap-proxy.mjs` で実測比較できる。実際に PA0100J（Enter 後・PageUp 後のカーソル）と YB0140R（窓の PageUp/PageDown）はこの方法で ACS と突き合わせて是正した（PR #404。IC/MC の WTD 単位確定・SOH での破棄・WEC でのカーソル復元・窓左端の属性打ち切り。`packages/tn5250/src/protocol/wtd-applier.ts` の `PendingCursorOrder`、回帰テスト `packages/tn5250/test/cursor-per-wtd.test.ts`）。~~**CURSORCL3 のシナリオだけは未実測のまま**なので、この項目は開けておく。~~
    **判定（`20260919-backlog-acs-triage`・PR #406）: 対応不要（差異なし・実害なし: 実測で一致）** — CURSORCL3 を ACS と当 PJ の両方で実機に当てた。
    手順: 検証ライブラリ（`AS400_LIB`）の CURSORCL3 で、1 画面目に `ABC123` を打って Enter を押す。
    2 画面目では CODE 欄が保護され、DSPATR(PC) も CODE 欄を指す。
    - ACS（`acshod2.jar` の HACL/ECL を headless で実行。`scripts/acs-probe.mjs`）: カーソルは **3 行 12 桁**（保護欄の中）
    - 当 PJ（`scripts/diag-ic-on-protected.mjs`）: **3 行 12 桁**
    ホストの IC/MC に従う点で一致し、PR#387 の分岐を撤去した判断を裏付ける。
    「ACS を利用者に起動してもらう」必要も無くなった（ECL でコアを直接動かせる）。（research F1-14・F0-2）
- [x] 当プロジェクト全体でACSの実装と突き合わせるべき挙動の棚卸し（利用者から「全体的にACSを手本に見直しを図ってください」との要望、20260915）のうち、**第1弾（プロトコル仕様そのものの突き合わせ、ACS・実機起動どちらも不要）**を実施した（`20260915-acs-protocol-order-audit`）。ACS のデコンパイル済みコア（`DS5250.processWriteToDisplay()`のオーダーswitch、`PS5250.addChar()`の文字書き込み処理）と `wtd-applier.ts` を突き合わせ、オーダー対応は1:1で一致していることを確認。あわせて `ORDER.UNKNOWN_1C`（0x1C）の対（0x1E）に専用の`case`が無く、遭遇すると同一WTD内の以降の全オーダーが失われる欠陥を発見・修正した（`ORDER.UNKNOWN_1E`追加、`packages/tn5250/test/wtd-applier.test.ts`に回帰テスト追加）。残作業は下記に割る。
  - [x] 見た目のヒューリスティックの是非~~（利用者の実機操作＝ACS起動が必要）~~、および DSPFMT の再現待ち（利用者の実機ライブラリへの変更判断が必要）は未着手のまま。
    **絞り込みの叩き台（20260915、旧記述を残す）**:
    2. **[利用者の実機操作が必要] 見た目のヒューリスティックの是非**: ~~SEU の PageUp/PageDown 境界カーソル（本ファイル上の項目）のような~~「ACS のコアには専用ロジックが無いが見た目で挙動が違って見える」ケース。**訂正（`20260915-pdm-protected-cursor-pageup`）**: 上記の例（SEU の PageUp/PageDown 保護欄カーソル）は、実際には ACS 側の未知ロジックではなく当プロジェクト既存の分岐（PR#387）の誤発火が原因だったと判明し、ACS の UI層調査無しで解決済み（本ファイル上の該当項目参照）——このカテゴリの**例としては不適切**だったが、カテゴリ自体（ACS のコアに専用ロジックが無いのに見た目が違って見える、未解決のケース全般）は依然として残りうる。ACS の UI 描画層（コアのデコンパイルでは追えなかった）に踏み込むか、`tap-proxy.mjs` で利用者に ACS を実際に起動してもらい実機と同時比較するかのいずれかが要る——~~**この work だけでは実行できず、利用者の協力（ACS 起動・実機操作）が前提**。~~
    3. **[利用者の実機ライブラリへの変更判断が必要] DSPFMT の再現待ち**: 本ファイル上の別項目。**訂正（`20260915-dspfmt-reconnect-blank-redraw`）**: 利用者からの新しい再現手順を得て再現・原因特定に成功し、`QRPGLESRC` 整備を待たずに解決した（本ファイル上の該当項目参照）——ただし色符号化（DSPATR(CS)）に関する別のサブ課題は `QRPGLESRC` 整備待ちのまま残っている。
    次に着手する際は `20260915-acs-protocol-order-audit` の decisions.md D1（`ORDER.UNKNOWN_1C`/`UNKNOWN_1E` のアーキテクチャ上の位置づけの見直しは今回scope外とした）も参照。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md, .aidev/works/20260915-acs-protocol-order-audit/decisions.md）
    **判定（`20260919-backlog-acs-triage`・PR #406）: 対応不要（解決済み: 具体的な対象が残っていない）** —
    - DSPFMT は #401 で解決済み（`20260915-dspfmt-reconnect-blank-redraw`。8/8 で解消を実測）。
    - 「見た目のヒューリスティック」には、具体的な未解決の事例が残っていない。
    - 前提だった「ACS の起動には利用者の協力が要る」は崩れた。ACS のコアは `scripts/acs-probe.mjs`（HACL/ECL）で、利用者の手を借りずに実機へ当てられる。
    今後の事例は、見つけたものから個別に起票する（`20260919-backlog-acs-triage` で起票した新規の項目を参照）。（research F1-15・F0-2）
- [x] 当プロジェクト全体でACSの実装と突き合わせるべき挙動の棚卸し（利用者から「全体的にACSを手本に見直しを図ってください」との要望、20260915）のうち、**第2弾（フィールド入力値検証`field-validate.ts`の突き合わせ、ACS・実機起動どちらも不要）**を実施した（`20260915-acs-field-validation-audit`）。ACSのデコンパイル済みコア（`Field5250`の`checkNumericOnlyChar()`・`checkDigitsOnlyChar()`・`checkAlphaOnlyChar()`・`checkKanaShiftChar()`）と`field-validate.ts`を突き合わせ、数値専用欄（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）で埋め込みの空白文字を拒否していた食い違いを発見・修正した（ACSは位置を問わず空白を許容する。正規表現を`/^[0-9.,+-]*$/`→`/^[0-9 .,+-]*$/`に変更、回帰テスト`packages/tn5250/test/field-validate.test.ts`）。数字のみ・英字専用・カタカナシフトの検証は既に一致していることを確認済み。残作業は下記に割る。
  - [x] **自己点検欄（モジュラス10/11、FCW経由で付与される属性）~~が当プロジェクトに未実装~~**（`20260915-acs-field-validation-audit` decisions.md D2）。ACSの`Field5250.checkModulusField()`/`modulusCheck()`が標準的なモジュラス10/11アルゴリズムを実装しているが、当プロジェクトの`wtd-applier.ts`は未知のFCWを安全に読み飛ばすためパース破壊は起きない（feature gapでありbugではない）。実装を見送った理由: (1) 正確なFCW値（~~`0xB0xx`/`0xB1xx`系と推測されるが未確定~~）がデコンパイル結果だけからは一意に確定できず、実機トレースが必要。(2) モジュラス10/11の検証はフィールド全体の最終値に対して行うもので、既存の「打鍵・貼り付けされた差分文字を1文字ずつ検証する」という`validateFieldContent()`の構造とは粒度が異なり、別途フィールド確定時検証を新設する設計が要る。次に着手する際は、実機で自己点検欄付きの画面を作り生バイトを採取して正確なFCW値を確認することから始める——アルゴリズムの詳細は`.aidev/works/20260915-acs-field-validation-audit/research.md` F6に記録済み。（出典: .aidev/works/20260915-acs-field-validation-audit/research.md, decisions.md） **実装済み（2026-09-17・PR #404）**: FCW は ACS `Field5250` の定数（`javap -constants`）で確定した——`FCW_SELF_CHECK_MODULUS_11=0xB140` / `FCW_SELF_CHECK_MODULUS_10=0xB1A0`。`wtd-applier.ts` の `applySf` が `Field.selfCheck`（`mod10`/`mod11`）として載せ、検算は `Field5250.checkModulusField()`/`modulusCheck()` を写した `selfCheckDigitOk`（`packages/tn5250/src/screen/field-validate.ts`）。粒度の問題（上記 (2)）は、差分文字の検証ではなく **AID 送信前の検査**（web-ui `composables/mandatoryCheck.ts`、`MANDATORY_ENTER`/`MANDATORY_FILL` と同じ場所）に置くことで解いた——ACS も送信時に検算する。回帰テスト: `packages/tn5250/test/fcw-dbcs-self-check.test.ts`・`packages/web-ui/test/self-check-field.test.ts`。同時に DBCS の FCW を ACS の 4 値（`0x8200`=only/`0x8220`=pure/`0x8240`=either/`0x8280`=open）へ揃えた。

## 方針決定（2026-09-21・利用者の判断）

要判断だった項目の方針。**着手時はこの方針に従う**。判断材料は原典（`javap -c -constants`）と実機で確かめた。

| 論点 | 方針 | 根拠 |
|---|---|---|
| **操作員エラーでキーボードを施錠するか** | **施錠する＋Reset キーを作る**（ACS と同じ）→ **実装済み（`20260921-operator-error-mode`）** | 実機で `inhibit=5` を観測（`20260920-insert-mode-overflow` research F9〜F11）。解除に Reset が要るので一緒に実装する。全操作員エラーに波及する |
| **施錠中・応答待ち中の先打ち** | **溜めて解錠時に再生する**（Attn/SysReq/Reset/Help で捨てる）→ **実装済み（`20260921-type-ahead`）** | 既定は先打ち有効（`DISABLE_SESSION_TYPE_AHEAD = false`）。PR #388 の「打てるのに Enter が効かない」を入力を失わずに解く |
| **ホストに切られた後** | **自動で繋ぎ直す**（通常の切断で即座、以後 20 秒おき） | 原典＋実機（ENDCNN 後 3 秒で再接続）。サインオン拒否では止まるので QMAXSIGN の輪にならない |
| **欄を出ないまま AID** | **操作員エラー 0020 にして送らない** → **実装済み（`20260921-aid-without-field-exit`）** | `PS5250.processAIDCode`。左詰めのまま右寄せ欄へ格納される不整合を防ぐ |
| **ME/MF（必須入力・必須埋め）の判定** | → **実装済み（`20260921-mandatory-check-acs`）** **ACS に合わせる**——ME を MDT で判定し、CF キーや Roll でも検査。MF と自己点検は欄を出るときにも検査 | 利用者の判断。**`20260729-ffw-behavior-bits` D1（Enter のときだけ・内容で判定）を破棄**する。D1 は「CA/CF の区別は端末に届いていない」を前提にしていたが、ACS が区別しているなら届いているはずで、**着手時に原典で確かめる**（D1 が恐れた「必須欄が空の画面から F3 で抜けられない」は、F3 が CA キーなら起きない） |
| **either 欄の DBCS 状態** | **ACS に合わせる**——either 欄が「いま DBCS 側か」の実行時状態を持ち、DBCS 側なら取り置く | 利用者の判断。**`20260920-insert-mode-overflow` D5（either は取り置かない）を破棄**する。ACS `PS5250.insertChar` は `isEitherFieldDBCSOn()` を見る。PR #409 の着地後に着手する（D5 がそこにあるため） |

**施錠の 2 種類は別物**——操作員エラーの施錠（Reset で解く・ACS はこの間の打鍵を拒否）と、
応答待ちの施錠（ホストの解錠で解ける・ACS はこの間の打鍵を溜めて再生）。
方針を決めた段階では「施錠の方針が先打ちの前提」と書いていたが**言い過ぎだった**。本当の結合は
「操作員エラーで施錠するなら Reset キーが要る」の 1 点。

<!-- 以下 20260919-backlog-acs-triage: ACS のコアのうち未突き合わせだった 3 領域（DS5250 の WTD 以外 / キー入力・編集・AID・施錠 / telnet・プリンター）の差異。
     深さ: ◎ 実測 / ○ 主エージェントが両側を直読 / ◐ 片側を直読 / △ 委譲先の報告のみ（着手時に両側を再確認）。組の一覧は同 work の acs-comparison.md -->
- [x] **Attn・SysReq・ヘルプから戻ると、打鍵した文字と MDT が消える（RESTORE SCREEN で自分の退避イメージを再適用する）**（優先度 高・深さ ◎）。
  打ったまま送っていない入力は、Attn やヘルプを開いて F12 で戻ると消え、Enter で再送されない（データが黙って失われる）。
  CA マスクも戻らないので、F12 で欄データを送ってしまう（委譲先のプローブ）。
  ACS: `DS5250.processSaveScreen` が状態一式を退避データに入れ、0x12 で丸ごと戻す（`Save5250Net` の直列化）。
  状態一式は、欄・全プレーン・カーソル・施錠・保留中の READ・メッセージ行・CA マスク。
  当 PJ: `packages/tn5250/src/protocol/wtd-applier.ts:204` の `RESTORE_SCREEN` は、ローカルのスタックから戻したあと `break` する。
  そのため、同じレコードに続く積荷（自分が送った `ESC 11 …` の WTD）を、次のコマンドとして適用してしまう。
  積荷を作る `save-screen.ts` の `writeCell` は `rawByte ?? 0x40` なので、打鍵した文字は空白になる。SF は元の FFW を使うので、MDT も落ちる。
  `save-screen.ts:17-22` の「積荷は読まない」という記述と、実装が食い違っている。
  再現（実機で ACS と並べて実測）
  - 操作: メインメニューのコマンド行に `WRKACTJOB` を打ち（送らない）、Attn → F12 と押す。
  - ホストの応答: Attn には `ESC 02`、F12 には `ESC 12` の後ろに `ESC 11`。
  - 当 PJ: 戻った後のコマンド行は空欄で、MDT=false。
  - ACS（`scripts/acs-probe/attn-restore.txt`）: `WRKACTJOB` が残り、カーソルも 20 行 16 桁に戻る。
  手当ての候補（委譲先 C の案。着手時に再確認）: 復元時は自分の積荷を長さで読み飛ばす／退避に CA マスク・メッセージ行を含める／スタックを名指しで引く。
  画面イメージ応答の打鍵文字の扱いは、下の【まとめ】DS5250 のその他に入れた。
  （出典: `20260919-backlog-acs-triage` research N1）
  **完了（`20260920-restore-screen-parity`・PR #407）**——3 つの候補のうち「長さで読み飛ばす」と
  「退避に CA マスク・メッセージ行を含める」を採った。~~ホストの応答: F12 には `ESC 12` の後ろに `ESC 11`~~
  は**経路によって違った**——QSH から F3 で抜けると `ESC 12` ＋ 積荷 ＋ **`ESC 52`（READ MDT）が同一レコード**に
  載る（実機で 2 回再現）ので、「レコードの残りを捨てる」は使えない（`decisions.md` D10）。
  - 積荷は**送った長さぶん照合して読み飛ばす**（`packages/tn5250/src/protocol/wtd-applier.ts` の
    `restoreAndSkipPayload`）。退避段に積荷を添える口は `ScreenBuffer.attachSaveContext(depth, …)`
    ——**段は頂点ではなく番号で指す**（1 レコードに SAVE が 2 回入ると頂点では先の段に添えられない）
  - 退避に **CA マスク（`aidNoDataMask`）・メッセージ行番号（`msgLineRow`）・保留中の READ** を追加。
    保留 READ は `ScreenBuffer` の退避段へ入れ、**スタックを 1 本に統合**した（2 か所で持つと
    早期 return や例外で段数がずれる）。施錠（ACS `SaveKeyboardLocked`）は**対応物が無い**と判定（D12）
  - 打鍵は**フラグキー（Attn / SysReq）でもサーバーへ渡す**ようになった（施錠中を除く）。
    ACS が打鍵を表示バッファに持つのと同じ形（`packages/web-ui/src/session-controller.ts` /
    `packages/server/src/ws-handler.ts`）。**ホストへ送るバイト列は変えていない**
  - **実機で ACS と一致**: Attn は 10B・flags `0x40`・本体空、**F12 は本体 `14 1a 3c` でバイト単位一致**、
    SAVE 応答の opcode は **`0x04`（受信の写し。従来は `0x05` 固定）**。
    復元後は `WRKACTJOB` が残り MDT=true（従来は空欄・MDT=false）
  - 回帰テスト: `packages/tn5250/test/restore-screen-payload.test.ts`（16 件・新規）/
    `save-screen-session.test.ts`「1 レコードに SAVE が 2 回」/ `packages/server/test/err-shape.test.ts`（9 件・新規）/
    `packages/web-ui/test/flag-key-fields.test.ts`（5 件・新規）
- [ ] **挿入モードで欄が満杯のとき、あふれた末尾の文字を黙って捨てる。符号付き数値欄では値が化ける**（優先度 高・深さ ○）。
  末尾まで埋まった欄（SEU の行など）や、ホストが右寄せで書いた数値欄を挿入モードで直すと、文字が消えたり値が変わったりして送られる。
  例: 右寄せの `"   12-"`（−12）の `1` の前に `9` を挿入すると `"   912"` になり、送信は `91` になる。
  ACS: `PS5250.insertChar` → `reserveRoomForInsert` が、最終桁（符号付き数値は符号桁の手前）から空きを数える。足りなければエラー 0012 を出し、値を変えない。
  当 PJ: `packages/web-ui/src/composables/fieldEdit.ts:33-36` が splice の後、`chars.length = len` で切り詰める。
  貼り付けは既に「余地が無ければ何も変えない」規則なので、打鍵とで食い違っている。
  テスト `field-edit.test.ts:33-40` は、満杯でない欄の挿入しか見ていない。
  再現: 満杯の欄で挿入モードにして、1 文字打つ。
  関係: AGENTS.md の残課題「挿入モードで 1 行が帯の幅を越えたときの ACS 挙動が未確認」。`reserveRoomForInsert` は欄の最終桁から数えるので、継続欄（複数行の欄）で「欄全体の予算」を見ているかを、着手時に確かめれば閉じられる見込み（推測）。（出典: `20260919-backlog-acs-triage` research N2）
- [x] **施錠中・応答待ち中の打鍵（先打ち）を黙って捨てる**（優先度 高・深さ ◐・**方針決定済み：A 溜めて再生**）。
  **完了（`20260921-type-ahead`・PR #410）**: 施錠中（応答待ち・ホスト施錠）の端末のキーをセッションごとに溜め（`SessionState.typeAhead`）、
  解錠したら合成 keydown を同じ入口へ投げて打った順に再生する（`packages/web-ui/src/components/EmulatorPane.vue` の先打ちの節、
  分類は `useKeymap.ts` の `typeAheadKind`）。AID を再生して施錠したら止め、残りは次の解錠で続きから。
  実機の ACS（ECL の `SendKeys`）で確かめた——施錠中の `ABC` が解錠後のコマンド行へ・`DSPLIBL`+Enter が解錠後に送られる・
  Reset で溜めが捨てられる（ホストの施錠は解けない）・Enter の連打の 2 回目が送られる（research F2）。
  GUI の打鍵も同じ `ECLPS.SendKeys` を通ることを原典で辿った（F1）。Insert は溜めずにその場で切り替える（`[insert]` は溜めない）。
  テスト `packages/web-ui/test/type-ahead.test.ts`（36 件）。節目の独立点検の指摘（タブ切替・非フォーカス・再生中の状態）も直した。
  ⚠ 当 PJ の都合の差: よそのペインにフォーカスがある間は流さない（ACS は流す。D7）。IME・ペーストは溜めない（ACS 側が未確認）。
  **方針（利用者の判断・2026-09-21）: A）ACS と同じく溜めて、解錠時に再生する**（Attn / SysReq / Reset / Help で捨てる）。
  原典で既定を確認——`beans/HOD/Session` は設定が無ければ `DISABLE_SESSION_TYPE_AHEAD = false`（＝先打ち有効）。
  PR #388 が施錠中の打鍵を禁じたのは「打てるのに Enter が効かない」壊れた状態を避けるためだった。**溜めて再生すれば、入力を失わずに同じ問題が解ける**（Enter も `pending_aid` として溜まる）。`keyboard-locked-input.test.ts` の固定は方針に合わせて書き換える。
  Enter の直後に次のコマンドを打ち始めたり、Enter を続けて押したりすると、入力の頭が欠ける（熟練者ほど踏む）。
  利用者の「待たされる」報告の候補の 1 つ（session-lifecycle.md の「最近の接続状態維持・再接続対応以降…不安定化」の項目）。
  ACS
  - `ECLPS.SendKeys` が、施錠中や READ が来ていない間の打鍵を `keyBuffer` に溜め、解錠や READ の到着で再生する。
  - AID も `pending_aid` として溜め、READ が来たら送る（`DS5250.checkPendingAid`）。
  - Reset / SysReq / Help / Attn を押すと、溜めた分を捨てる。
  - 既定は有効（`DISABLE_SESSION_TYPE_AHEAD` の既定は false。`beans/HOD/Session.java:836-842`、設定画面の「キーストロークのバッファリング」は `KeyPanel.java:170`）。
  - GUI の打鍵がこの経路を通るかは未確認（要実測）。
  当 PJ
  - `ScreenGrid.vue` の `onInputKeydown` が、`inhibited` のときに捨てる。
  - `EmulatorPane.vue:851` が、busy 中は Attn / SysReq 以外を捨てる。
  - 施錠中の先打ちを禁じたのは PR #388（09-03）。テスト `keyboard-locked-input.test.ts` が現状を固定している。
  要判断（方針）: 次のどれにするかを決める。
  - A) ACS と同じく溜めて、解錠時に再生する（Attn / SysReq で捨てる）
  - B) 捨てるが、捨てたことを操作員メッセージで知らせる
  - C) 現状のまま
  下の「READ の無いアンロック」と合わせて設計すること。
  （出典: `20260919-backlog-acs-triage` research N3・F3-3）
- [x] **DBCS プリンターの申告内容が ACS と違う（日本語帳票を push で印刷できるかの分かれ目）**（優先度 高・深さ △・**要実測**）。
  **完了（`20260921-printer-acs-declaration`・PR #410）**: 申告を ACS の 4 通りの組（DBCS / SBCS × HPT あり / なし）にした
  （`packages/tn5250/src/session/terminal-type.ts` `printerDeclaration`・`telnet.ts` の `userVars` / `sendConfRec`）。
  **実測**: 日本語機で 3812 の装置に DBCS で繋ぐと 5553 に作り変えられ、IGC 属性の DSPLIBL が CPA3303 で止まらず帳票として届いた
  （`scripts/verify-printer-dbcs-push.mjs` pass=5）。旧い組では 5553 の装置も 3812 にされ CPA3303。PUB400 では ACS の組は I902、
  当 PJ の変数を 5553 に載せると 8925（`docs/HOST-PRINT-TRANSFORM.md` §2 の「5553 は 8925」の原因は変数の組だった）。
  ⚠ 英語機では日本語が置換される（CODEPAGE / CHARSET を送らないため。ACS と同じバイト。ACS そのものは未測定）。
  ACS: `DS5250P.initializeTelnet` は、DBCS で HPT なしのとき、端末タイプを `IBM-5553-B01` にする。
  NEW-ENVIRON で送るのは、次の 6 つだけ（IBMFONT・KBDTYPE/CODEPAGE/CHARSET・IBMSENDCONFREC は送らない）。
  - DEVNAME
  - IBMMSGQNAME=QSYSOPR
  - IBMMSGQLIB=*LIBL
  - IBMFORMFEED（値なし）
  - IBMIGCFEAT=2424J0
  - IBMTRANSFORM=0
  当 PJ: 常に `IBM-3812-1`（`packages/tn5250/src/session/terminal-type.ts:44-47`。主エージェントが確認）で、IBMFONT=12・KBDTYPE 等・IBMSENDCONFREC も送る（`printer-session.ts:122-135`）。
  `docs/HOST-PRINT-TRANSFORM.md` §2 の「5553-B01 → 8925」の試験は、当 PJ の既定の変数も一緒に送った条件だった可能性が高い（ACS と同じ条件ではない）。
  測り方: 端末タイプ `IBM-5553-B01` と、ACS と同じ 6 変数だけで接続し、次を見る。
  - 起動応答コード
  - `DSPDEVD` の TYPE / MODEL / IGCFEAT
  - IGC 帳票で CPA3303 が出るか
  **着手時に ACS 側・当 PJ 側の両方を再確認すること**（委譲先の読みのみ）。（出典: `20260919-backlog-acs-triage` research N4）
- [x] **WTD の CC1=0xC0（MDT のリセット＋MDT の立った欄の消去）で、欄を消さない**（優先度 中・深さ ○）。
  **完了（`20260921-wtd-cc1-c0-order`）**: `applyCc` の `case 0xc0` で**消してから MDT を落とす**順序に直した（`packages/tn5250/src/protocol/wtd-applier.ts`）。
  原典で確認——`DS5250.processWCC1` は `cc1 >> 5` の tableswitch で分岐し、**case 6** は`clearNonbypassFields(true)` → `resetMDTFields(true)` → `lockKeyboard(8)` の順。
  ⚠ **実機で 0xC0 を出させてはいない**（候補 DDS `ERASEINP MDTOFF` は未確認）。合成 WTD で固定した。付随の差（継続欄の全区間・DBCS 専用欄の SO/SI 桁）は手付かず。
  入力を消すべき画面で、打った値が残る。
  ACS: `DS5250.processWCC1` の case 6 は、先に `clearNonbypassFields(true)`（MDT の立った欄を消す）を呼び、その後で `resetMDTFields(true)` を呼ぶ。
  当 PJ: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyCc` の case 0xc0 は `resetMdtNonBypass()` を先に呼ぶ。そのため、続く `nullNonBypass(true)`（MDT の立った欄だけを消す）の対象が 0 件になる。
  手当ては、呼ぶ順序の入れ替え。付随の差（継続欄の全区間・DBCS 専用欄の SO/SI 桁）は委譲先 C の報告にある。
  再現
  - 単体: CC1=0xC0 の WTD を合成すれば再現する（委譲先 C のプローブで、打った `"ABC"` が残った）。
  - 実機: 0xC0 を出す DDS（候補は `ERASEINP MDTOFF`）は要実測。
  （出典: `20260919-backlog-acs-triage` research N5）
- [ ] **READ だけのレコード（WTD 無し）でも、カーソルを先頭の入力欄へ動かす**（優先度 中・深さ ○・**要実機測定**）。
  **`20260921` のバッチで着手を見送った**。原典を読むと、ACS が既定位置を置くのは`DS5250.preprocessWCC2`（WTD の処理の中）で、条件に `WCC2_unlock_pending`・施錠状態・`kbd_state_chg` が絡む。
  単純に「WTD が無ければ動かさない」にすると、**WRITE と READ が別レコードで来る画面で既定位置が一度も置かれなくなる**（当方は既定位置を `readRequested` のときだけ置いており、ACS は WTD ごとに置く）。**判定の単位そのものが違う**ので、推測で直すと多くの画面のカーソル位置を壊しうる。
  着手時は、分割レコードの画面（RESTORE 後・WRITE と READ が別レコード）を**実機で**測ってから、`readRequested` で括るのをやめて WTD ごとに判定する形へ寄せること。
  前の WTD の IC や、復元した位置を上書きしてしまう。当たるのは、RESTORE の後や、WRITE と READ が別レコードで来る画面。
  ACS: `DS5250.processCommand` の READ INPUT / MDT / MDT ALT（66/82/130）は、`pending_read` と CC を保存するだけで、カーソルに触れない。カーソルを決めるのは、WTD の後の `preprocessWCC2` だけ。
  当 PJ: `packages/tn5250/src/session/session.ts:666` の `if (result.readRequested && !result.cursorSet)` が `cursorToFirstInputField()` を呼ぶ。WTD の無いレコードでは `cursorSet` が偽のままなので、必ず動く。
  再現: 委譲先 C のプローブで、復元後の READ だけのレコードで、カーソルが (7,12) から (5,10) に移った。実機で出る画面は要確認。
  （出典: `20260919-backlog-acs-triage` research N6）
  **実機で測った（2026-09-21・`20260921-auto-reconnect` の節目の合間に）**:
  - **現実の画面では差が出なかった**: WRKOBJ の一覧でコマンド行（21,7）から QSH を起動し F3 で戻る（出口は
    `RESTORE SCREEN`＋`READ MDT` の 1 レコード。WTD 無し）——**ACS も当 PJ も 21,7 のまま**
    （`scripts/acs-probe/read-only-cursor.txt`・`scripts/verify-read-only-cursor.mjs`）。一覧の既定位置（8,2）へは動かない。
    当 PJ は復元でカーソルを置いた扱いになり、既定位置へ動かさない。
  - **差が出うるのは「WTD（IC が先頭以外）と READ が別レコード」の画面**だが、実機で作れていない——DSM（`DSCMD`）は
    出力を 1 レコードにまとめて送った（CLEAR UNIT と WTD が 907 バイトの 1 レコード）。
  - 残り: 別レコードで来る画面を実機で見つけるか作る（DSM 以外。RPG の `WRITE` と `READ` を別に出す等）。見つかるまでは直さない。
- [x] **Erase Input が、中身のある全入力欄を消す（ACS は MDT の立った欄だけを消し、カーソルをホーム位置へ移す）**（優先度 中・深さ ○）。
  **完了（`20260921-erase-input-mdt-only`）**: 消すのを**MDT の立った欄だけ**にした（ホストが立てた `f.mdt` か、利用者の `edits`）。着地は `focusCursorField`（IC で指した位置、無ければ先頭の入力欄）へ寄せた（`packages/web-ui/src/components/ScreenGrid.vue` `eraseInputKey`）。
  原典で確認——`PS5250.processEraseInput` は `clearNonbypassFields(true)`、着地は `getHomePos()`。`homePos` は `setInsertCursor`（IC）で決まり、無ければ `setDefaultInsertCursor`。
  ⚠ 着地位置は単体で固定していない（IC で別の欄を指す画面でのみ差が出る）。
  ホストが既定値を入れた未変更の欄（プロンプタの `*LIBL` など）まで消え、空白が「変更」として送られる。
  既定の割り当ては Ctrl+Backspace で、Windows の「前の単語を削除」の癖で押されうる。
  ACS: `PS5250.processEraseInput` → `clearNonbypassFields(true)`。カーソルは `getHomePos()` へ。
  当 PJ: `packages/web-ui/src/components/ScreenGrid.vue:2372` の `eraseInputKey` は、中身のある全入力欄に `edit` を出して消し、先頭の入力欄へ移る（README も「すべての入力欄をクリア」と書いている）。
  再現: F4 のプロンプトで 1 欄だけ打ってから、Erase Input を押す。（出典: `20260919-backlog-acs-triage` research N7）
- [x] **挿入モードが画面をまたいで残る（ACS は新しい画面ごとに上書きモードへ戻す）**（優先度 中・深さ ○）。
  **完了（`20260921-insert-mode-per-screen`）**: 既存の `watch(snapshot, …)` に`insertMode.value = false` を足した（`packages/web-ui/src/components/EmulatorPane.vue`。監視は増やしていない）。
  ~~⚠ **Reset キーは未実装**（ACS は Reset でも戻す）。~~ **Reset は `20260921-operator-error-mode` で実装**（左 Ctrl 単独。エラーでなくても挿入モードを解く＝ACS `ECLPS.reset`・実機で確認）。
  前の画面で挿入モードにしたまま次の画面で打つと、意図せず挿入になる。上の「挿入モードであふれた文字を捨てる」と重なって、末尾が消える。
  ACS: `DS5250.initKeyboard`（`resetInsertMode` を呼ぶ）を、`processClearFMT`・WEC・書式の開始から呼ぶ。
  当 PJ: `packages/web-ui/src/components/EmulatorPane.vue:95` の `insertMode` は、利用者の切り替えでしか変わらない。Reset キーも無い。
  再現: 挿入モードにして Enter を押し、次の画面で打つ。（出典: `20260919-backlog-acs-triage` research N8）
- [x] **Shift+Enter で画面を送信する（ACS では Newline＝次の行の入力欄へ移るだけ）**（優先度 中・深さ ○）。
  **完了（`20260921-shift-enter-newline`）**: Shift+Enter を局所操作 `newline` にし、送信しない形にした（`packages/web-ui/src/composables/useKeymap.ts`・`EmulatorPane.vue`）。次の行で始まる最初の入力欄へ移り、無ければ先頭へ巡回する。
  原典で確認——`PS5250.processNewline` は次の行の先頭を起点に `FFT5250.nextNonByPassInputFieldPos`。
  ⚠ 未対応の差: 次の行の先頭が行またぎ欄の中に当たる場合（ACS はその欄の中へ置く）／Ctrl 側の `C17 = [newline]`（キーを特定していないので推測で割り当てない）。
  サブファイルの入力中に ACS の癖で Shift+Enter を押すと、入力途中のまま送信される。
  ACS: 既定のキー割り当て `AcsMapFunctions.MAP_5250` が、`S10 = [newline]`（Shift+Enter）と `C17 = [newline]` を持つ。`PS5250.processNewline` はホストへ送らない。
  当 PJ: `packages/web-ui/src/composables/useKeymap.ts:72-73` は Shift を見ずに Enter の AID を返す。Newline の機能そのものが無い。
  テスト `keymap.test.ts:17-18` は、Enter → Enter だけを見ている。（出典: `20260919-backlog-acs-triage` research N9）
- [x] **起動応答コード 2703 / 2777 / 8936 / 8937 を知らない**（優先度 中・深さ ○）。
  **完了（`20260921-startup-codes-unknown`）**: `CODE_MEANING` に 4 エントリを足した（`packages/tn5250/src/telnet/startup-record.ts`）。認識はこの表のキーが出所なので、足すだけで直る。
  原典を `javap -c -constants` で確認——`DS5250.processStartUpConfirmation` の lookupswitch に個別の分岐が実在し、通信状態は **2703→12 / 2777→13 / 8936→33 / 8937→34**。
  ⚠ **2703 / 2777 の意味は未確認**（ACS の英語文言はメッセージカタログ側で、通信状態→キーを追えていない）。**それらしい英文を創作せず**、文言に「未確認」と書いてある。
  8936・8937 は自動サインオンの失敗・拒否を表す。当 PJ は自動サインオンを持つので、到達しうる。
  未知のコードで装置名が無いと、そのレコードを 5250 データとして読んでしまう。その結果、`expected ESC` の警告と `closed during negotiation` だけが残り、本当の理由が消える。
  ACS: `DS5250.processStartUpConfirmation` が、この 4 つにも個別の状態と文言を持つ。
  当 PJ: `packages/tn5250/src/telnet/startup-record.ts` の表（2702・8901〜8940・I901〜I906）に、この 4 つが無い。テスト `startup-reject.test.ts:133` が「未知コードで装置名なし＝データ扱い」を固定している。
  手当て: 表に足すだけで済む。文言の日本語化は下の【まとめ】telnet に入れた。（出典: `20260919-backlog-acs-triage` research N10）
- [x] **操作員エラーでもキーボードを施錠しない・Reset キーが無い**（方針決定済み：施錠する＋Reset キーを作る）。
  **完了（`20260921-operator-error-mode`・PR #410）**: web-ui にエラー状態を持たせた（`packages/web-ui/src/components/EmulatorPane.vue` の `errorMode` / `onKeydownCapture`、判定は `opMessages.ts` の `isOperatorError`）。
  規則は実機の ACS に合わせた（research F3・F5・F6）——**文字・Backspace・Delete は拒否**、**矢印・Tab・Home・AID・Reset・クリックで抜ける**、
  **エラーに入った時点で挿入モードが解ける**、**Reset（左 Ctrl 単独）はエラーでなくても挿入モードを解く**。
  「施錠」は Reset だけで解く硬い錠ではなかった（D1）。未測定のキー（Field Exit・Erase EOF・Dup・IME・Ctrl 組み合わせ）は抜ける側に倒した（D2）。
  テスト `packages/web-ui/test/operator-error-mode.test.ts`（18 件・mutation 6 通りすべて検出）。
  ⚠ Reset の「施錠中なら先打ちを捨てて解錠」（`ECLPS.reset`）は先打ちの項目で足す。
- [x] **ホストのエラー（WRITE ERROR CODE）でエラー状態に入らない・抜けてもメッセージ行を元に戻さない**（下の項目から割った）。
  **完了（`20260921-host-error-mode`・PR #410）**: コアが WEC ごとに通し番号（`ScreenSnapshot.systemMessageSeq`）を振り、ブラウザは番号の変化で
  操作員エラーと同じエラー状態に入る（文字を拒否・挿入モードを解く）。矢印・Tab・AID・Reset・クリックで抜けると、そのメッセージを隠して
  最下行を元に戻す。**実機**（試験画面 ULKPGM の RANGE(1 5) に 9）で ACS は inhibit=5・文字を拒否・挿入モードを解き、矢印・Tab で抜けると
  最下行が消えた（`scripts/acs-probe/window-error.txt`・`host-error-mode.txt`）。当 PJ の関係は `packages/web-ui/test/host-error-mode.test.ts`。
- [ ] **窓の中のエラーメッセージ（WRITE ERROR CODE TO WINDOW）を画面の最下行に出す**（優先度 ~~中~~ 低・深さ ◐）。
  **実機では差が無かった（2026-09-21・`20260921-host-error-mode` research F2）**: WINDOW キーワードの窓の中の RANGE 欄に範囲外を入れると、
  ホストは **0x22 ではなく WTD で窓の中（12 行目）に書き**、ACS もエラー状態に入らなかった。当 PJ も窓の中に出している。
  **0x22 そのものは実機で観測できていない**——来たら当 PJ は従来どおり最下行に出す。0x22 を出す画面が見つかったら着手する。
  ~~（元の見出し）窓の中のエラーメッセージ（WRITE ERROR CODE TO WINDOW）を画面の最下行に出す。エラー状態が明けてもメッセージ行を元に戻さない~~
  DDS の窓で入力エラーが出ると、ACS は窓の中に出すが、当 PJ は最下行に出す。訂正している間もメッセージが消えない。
  ACS（委譲先 C の読み）
  - WEC は、SOH が申告したメッセージ行（MSGLOC）に書く。0x22 は、指定の桁範囲（窓の内側）に属性付きで書く。
  - エラー状態の間は、文字キーと編集キーを拒否する。
  - Reset・矢印・AID でエラー状態を抜けると、メッセージ行をエラー前の内容に戻す（`PS5250.saveMsgLinePosition` / `restoreMsgLinePosition`・`keyDown`）。
  当 PJ（主エージェントが確認）
  - `packages/tn5250/src/protocol/wtd-applier.ts:293-299` は、0x22 の桁 2 バイトを読み捨て、`systemMessage` として最下行に重ねる。このことはコメントに明記されている。
  - ~~エラー状態は持たない。~~（`20260921-operator-error-mode` で持った）
  ~~要判断（方針）: エラー状態の間の文字キーを A) ACS と同じく拒否する／B) 現状どおり通す（`opMessages.ts` に「打鍵を止めない」意図の記録がある）。~~ **エラー状態と拒否は上の `20260921-operator-error-mode` で済んだ（A）**。残りはメッセージ行の位置（窓の中）と、抜けたときの復元。
  **ACS 側は着手時に再確認すること。**（出典: `20260919-backlog-acs-triage` research N11）
- [x] **メッセージ待ち表示（MW）を出さない**（優先度 中・深さ ◐）。
  **完了（`20260921-message-waiting-indicator`）**: CC2 の MW ビットを解析し、セッションの状態からスナップショットへ載せ、ステータスバーに表示灯（`✉ メッセージあり`）を出した（`wtd-applier.ts` `applyCc2`・`session.ts` `snapshot()`・`StatusBar.vue`）。
  原典で確認——`DS5250.processWCC2` は `cc2 & 0x02` で消灯、続けて `cc2 & 0x01` で点灯（両方なら点灯）。ビットの無い WTD では状態を保つ。
  ⚠ **実機で MW を点けさせていない**（自分のメッセージ待ち行列へ SNDMSG すれば出せる）。
  *NOTIFY の待ち行列にメッセージが届いても（SBMJOB の完了など）、表示が出ない。
  ACS: CC2 のビット（0x01/0x02）と opcode 0x0B/0x0C で OIA を更新する（委譲先 C）。
  当 PJ: `packages/tn5250/src/session/session.ts:147/592-593` が opcode だけを `messageWaiting` に保持し、snapshot にも UI にも出していない（主エージェントが確認）。CC2 のビットは見ていない。
  再現: 自分のメッセージ待ち行列へ SNDMSG する。**ACS 側は着手時に再確認すること。**（出典: `20260919-backlog-acs-triage` research N12）
- [x] **プリンター: CLEAR に応答しない**（下の項目から割った）。
  **完了（`20260921-printer-acs-declaration`・PR #410）**: CLEAR に CLEAR_PROCESSED を返し、受けかけのジョブを閉じる（ACS `processClear` →
  `sendEOJ`）。応答は ACS と同じく「いまの応答」を持ち越す（`printer-session.ts` `handleRecord`）。実機でもジョブの終わりの直後に CLEAR が来た。
  あわせて**ジョブの終わりの判定**をフラグ 0x08 ＋ 本体が空か 0x00 にした（5553 では 16 バイトで届き、旧実装の「長さ 17」では帳票が
  確定しなかった）。応答の予約 2 バイトも ACS の 0x0102 にした。
- [ ] **プリンター: 受信した瞬間に印刷完了を返す**（優先度 中・深さ ◐）。~~／CLEAR に応答しない~~（上で済んだ）
  次のとき、ホストは印刷済みとみなすので、SAVE(*NO) のスプールが消える（印刷の欠落）。
  - PDF の出力先の権限・容量が足りない
  - 自動印刷先が止まっている
  - サーバーが再起動した（帳票はメモリに最大 50 件）
  印刷中に取消・保留をすると、前のジョブの断片が次の帳票に混ざりうる。
  ACS（委譲先 E の読み）
  - 書き終えてから NO_ERROR を返す。印刷先の障害時は応答を保留し、利用者の再試行・取消を待つ（`DS5250P.endOfRecord`・`PSNVT5250P`・`PrintHostData.write`）。
  - CLEAR には `CLEAR_PROCESSED` を返し、ジョブを閉じる（`DS5250P.processClear`）。
  当 PJ: `packages/tn5250/src/session/printer-session.ts:183-185` は、opcode 2 なら何もせず return し、それ以外は即座に `PRINT_COMPLETE` を返す（主エージェントが確認）。テスト `printer-session.test.ts:82-84` が即時の応答を固定している。
  再現: 印刷中に HLDSPLF *IMMED / DLTSPLF / ENDWTR *IMMED を行う。PDF の出力先を書き込み不可にして送る。
  **ACS 側は着手時に再確認すること。**（出典: `20260919-backlog-acs-triage` research N15）
- [x] **アンロックだけで READ の無い応答が来ると、応答待ちが解けない（#401 以降）**（優先度 低〜中・深さ ◐・**要実測**）。
  **実機で測って決着（2026-09-21・`20260921-type-ahead` の後）**: 試験画面 ULKPGM（`scripts/build-ulktest.mjs`。SNDF＝出力だけ・LOCK 無し・
  `DFRWRT(*NO)` → 10 秒 → SNDRCVF）で ACS と当 PJ を並べた。
  - **ACS**（`scripts/acs-probe/unlock-without-read.txt`）: 区間中は解錠を示す（inhibit=0）が、**打った文字は画面に入れずに溜め**、
    READ が来てから再生した（数字欄へ `ABC` が入ってエラー）。**Enter も READ の後に送った**（`ECLPS.SendKeys` は READ 待ちでない間も溜める）。
  - **当 PJ**（`scripts/verify-unlock-without-read.mjs`）: 区間中は施錠を示し、AID の応答待ちは READ が来た 10 秒後に解けた。
    ブラウザは `20260921-type-ahead`（先打ち）で区間中の打鍵を溜め、解錠後に同じ順で再生する——**打鍵の結果は ACS と同じ**。
  - ~~「ACS なら打てる区間が施錠のままになる」~~ は誤り（ACS も画面には打たせない）。~~抜けるには Attn / SysReq を押すしかない~~ は
    先打ちで解消した（待てば溜めた打鍵ごと進む）。
  - **残る差は OIA の表示だけ**（ACS は解錠、当 PJ は施錠）。当 PJ で解錠を示すと、ブラウザが打鍵を溜めずに画面の欄へ入れてしまい、
    かえって ACS と食い違うので、揃えない。
  - 試験画面は測定後に消す（`--clean`）。
  ~~抜けるには Attn / SysReq を押すしかない。「アンロック → 秒単位の処理 → READ」の画面では、ACS なら打てる区間が施錠のままになる。~~
  当 PJ: `packages/tn5250/src/session/session.ts:701-713` は、`readSolicited` のときだけ `ready` にして `pendingAid` を解決する（#401・`20260915-dspfmt-reconnect-blank-redraw`）。
  web-ui 経由の送信は `timeoutMs: "never"`（`packages/server/src/ws-handler.ts` の `onKey`）なので、期限による保険も無い。
  ACS: WCC のアンロックで解錠し（`DS5250.processWCC2` → `endOfRecord`）、解錠中の AID は `pending_aid` に溜めて READ が来たら送る（委譲先 C・D）。
  測り方: WRITE（LOCK 無し）→ `DLYJOB 10` → EXFMT の画面で、途中に打鍵と AID を試す。実機ではまだ観測していない（DSPFMT は最後が必ず READ だった）。
  上の「先打ちを捨てる」と合わせて設計すること。（出典: `20260919-backlog-acs-triage` research F3-3 H）
- [x] **ホストに切られた後、自動で繋ぎ直さない**（優先度 中・深さ △・**方針決定済み：ACS と同じく自動で繋ぎ直す**）。
  **完了（`20260921-auto-reconnect`・PR #410）**: コアの `Session5250` に `autoReconnect`（既定 false＝ACS の ECL のコアと同じ）を足し、
  サーバーがブラウザから開いたセッションでだけ ON にする（ACS の画面の層と同じ層分け）。確立した後にホストに切られたら、
  **1 回目は即座に、以後 20 秒おきに上限なく**同じセッションのまま張り直す。**自分から切ったとき・起動応答で拒否されたとき**
  （原典で全拒否コードが ACS の再接続の条件＝状態 2 以外に落ちることを確かめた）・**自動操作が予約している間**は繋ぎ直さない。
  経過は `/ws` の `host-reconnecting` / `host-reconnected` で知らせ、`opened` にも載せる（開き直したタブが取り残されない）。
  ブラウザは「ホストとの接続が切れたため繋ぎ直しています」を出し、送らず、溜めた先打ちを捨てる。
  **実機**: `SIGNOFF ENDCNN(*YES)` で約 0.05 秒後に新しいサインオン画面（コア単体 3 回・うち 1 回は装置名を固定、サーバー経由 2 回）。
  対照の `SIGNOFF`（ENDCNN(*NO)）・`DSCJOB` はホストが接続を切らず、繋ぎ直しは起きない。
  テスト `packages/tn5250/test/auto-reconnect.test.ts`（14 件）・`packages/server/test/ws-host-reconnect.test.ts`・
  `packages/web-ui/test/host-reconnect.test.ts`、寿命の表（`session-lifetime-matrix`）をホスト側からの切断で測る形に改めた。
  ACS 製品が既定を上書きしないことも原典で確かめた（`HOD/acs` の 222 クラスに該当なし）。
  **方針（利用者の判断・2026-09-21）: ACS と同じく自動で繋ぎ直す**——通常の切断（状態 2）で即座に、以後 20 秒おき。サインオン拒否（8936/8937）と利用者の切断では繋ぎ直さない。
  **利用者の指示（2026-09-21）: 判断の前に ACS の実際の挙動を調べる**——とくに、自動サインオンと組んだときパスワード拒否で再試行を繰り返し、QMAXSIGN でプロファイルが無効化されないか。
  原典で確認済み: HOD の bean 既定は `autoReconnect = true`（`beans/HOD/HODDefaults`）。ACS 製品が上書きするかは未確認。
  **ECL のコア自体の既定は `SESSION_AUTORECONNECT = false`**（`ECLConnection`）で、ON にしているのは bean の層。
  **調査結果（2026-09-21・原典＋実機）**:
  - **再接続する条件**（`ECLConnection.SetCommStatus`）: 通信状態が **2（通常の切断）**のときだけ再接続スレッドを起こす。
    **1 回目は即座、以後 20 秒おき、回数の上限なし**（`run()` は `Thread.sleep(20000)` して `StartCommunication`）。
    利用者が自分で切ったときは起こさない。
  - **自動サインオンの失敗・拒否では再接続しない**: 8936→状態 33 / 8937→状態 34 は、`connectState` を 33/34 にして
    `StopCommunication` するだけで、再接続の条件 `connectState == 2` を満たさない。
    → **「パスワード拒否で再試行を繰り返して QMAXSIGN でプロファイルが無効化される」懸念は ACS には当てはまらない**
    （判断材料で私が書いた懸念は誤りだった）。
  - **実機で確認**（`scripts/acs-probe/signoff-endcnn-reconnect.txt`・`PROBE_AUTORECONNECT=true`）:
    `SIGNOFF ENDCNN(*YES)` の直後に `commStatus=2` となり、**3 秒以内に自動で繋ぎ直して新しいサインオン画面**
    （新しい装置 `QPADEV000B`）が出た。**ENDCNN は再接続の条件（状態 2）に該当する**。
  - **測定で踏んだ罠（3 つ・いずれも「再接続しない」と誤読しかけた）**:
    (1) プロパティ `SESSION_AUTORECONNECT` を渡しても実効値は false のまま、
    (2) 接続前にリフレクションで立てても接続開始の処理が上書き、
    (3) そもそも `acs-probe.mjs` が環境変数を許可リスト（`pick`）で絞っており Java に届いていなかった。
    **`dump` に実効値（`autoReconnect=` / `commStatus=`）を出したことで 3 つとも見抜けた**。
  - **未確認**: 再接続のあと ACS が**自動サインオンを送り直すか**（プローブは画面へ打鍵してサインオンするので測れていない）。
    ただし送り直して拒否されても状態 33/34 で止まるので、**再試行の輪にはならない**。
  SIGNOFF ENDCNN(*YES)、QINACTITV による切断、ホスト側の回線断のあと、ACS なら新しいサインオン画面が自動で出る。当 PJ は利用者が開き直す必要がある。
  ACS: `ECLConnection` の `autoReconnect`（`HODDefaults` で true）で、切断されると 1 回目は即座に、その後は 20 秒おきに繋ぎ直す。利用者が自分で切ったときは繋ぎ直さない（委譲先 E）。
  当 PJ: 表示セッションは `closed` を受けると破棄する（`packages/server/src/session-manager.ts:746-752`）。ホストへ繋ぎ直すのは常駐プリンターだけ（`:1003-1013`）。
  ブラウザとサーバーの間の瞬断からの復帰（session-lifecycle.md）とは別の話。
  要判断（方針）: 次のどれにするかを決める。ACS 製品での既定値も要確認。
  - A) 自動で繋ぎ直す
  - B)「繋ぎ直す」ボタンを出す
  - C) 現状のまま
  **着手時に両側を再確認すること。**（出典: `20260919-backlog-acs-triage` research N18）
- [x] **欄を出ないまま AID を押すと、右寄せせずに左詰めで送る**（【まとめ】キー編集の細部から割った。方針決定済み：ACS と同じくエラー）。
  **完了（`20260921-aid-without-field-exit`・PR #410）**: RZ・RB・符号付き数値の欄に打って欄を出ないまま AID を押すと、送らずに操作員エラーにする
  （判定は `packages/web-ui/src/session-controller.ts` の `sendKey`、欄の種類は `mandatoryCheck.ts` の `needsFieldExit`、
  「打ったあとまだ欄を出ていない」の付け外しは `EmulatorPane.vue` の `noteFieldTyped` / `noteFieldExited` とカーソル監視）。
  実機の ACS で 13 通りを測って合わせた（research F2）——**Enter だけでなく F3（CA キー）・Roll も止まる**、Help・Clear は止めない、
  Field Exit・Tab で出れば送れる（Tab で出て戻ると左詰めのまま届く）、欄の中の矢印では出たことにならない。
  テスト `packages/web-ui/test/aid-field-exit-required.test.ts`（20 件・mutation 10 通りすべて検出）。
  ~~⚠ 符号付き数値の数字桁を満杯にしたときは、当 PJ が自動送りするので送れてしまう（ACS はエラー）。下の「RB/RZ 欄のフィールド終了」で揃える。~~
  → 誤り（確かめずに書いた）。当 PJ は符号桁に留まり、ACS と同じく 0020 になる（`20260921-field-exit-required-types` で確かめた）。
- [x] **ME/MF・自己点検の判定の時機と条件が ACS と違う**（【まとめ】キー編集の細部から割った。方針決定済み：ACS に合わせる）。
  **完了（`20260921-mandatory-check-acs`・PR #410）**: 実機の ACS（ADJPGM）で 9 通りを測って合わせた——ME は**全 AID で**・**MDT で**・
  **画面が変更済みのときだけ**、**CA キー（SOH の申告）では見ない**。MF と自己点検は**カーソル下の欄**を AID のときと**欄を出るとき**に見て、
  欄の先頭へ戻す。止めたらエラー状態に入る。判定は `packages/web-ui/src/composables/mandatoryCheck.ts`、順序は
  `session-controller.ts` の `checkBeforeAid`（ACS `processAIDCode` の順）、欄を出るときはペインのカーソル監視、CA キーはコアの
  `ScreenSnapshot.caKeys`。旧決定 `20260729-ffw-behavior-bits` D1 は取り消し線で残して破棄した。エラー番号の注記も 0007 / 0014 / 0015 に直した。
  テスト `mandatory-check-acs.test.ts` ほか（mutation 9 通りすべて検出）。
- [x] **RB/RZ 欄（と符号付き数値）を満杯まで打つと、次の欄へ自動送りする（ACS は Field Exit 必須として留まる）**（【まとめ】から割った）。
  **完了（`20260921-field-exit-required-types`・PR #410）**: `isFieldExitRequired`（FER ∨ RZ ∨ RB ∨ 符号付き数値。ACS `Field5250.isFieldExitRequired`）で
  自動送り・自動 Enter・Dup の後の送りを止めた（`packages/web-ui/src/composables/mandatoryCheck.ts`・`ScreenGrid.vue`）。最終桁まで打てば
  0020 の待ちを外す（ACS の `fieldExited`。実機の場合 10: RZ 満杯で Enter が通る）。~~符号付きは数字桁を埋めても 0020 のまま（場合 11）。~~
  （場合 11 は 6S0＝7 桁に 5 桁の読み違い。6 桁打てば送れる）
  ~~⚠ 満杯で留まるカーソルの位置は ACS と 1 桁違う（ACS は最終桁、当 PJ は最終桁の後ろの境界）。~~
  **独立点検の後に揃えた**: カーソルは最終桁に留まり、さらに打つと 0018・左矢印は動かない・Backspace の後は 0020・
  Field Exit は最終桁を消さない。Dup は Field Exit 必須でも次の欄へ（旧「FER 欄は留まる」は ACS と逆だった）。
  実機の ACS で測った（`scripts/acs-probe/field-exit-full.txt`）。テスト `aid-field-exit-required.test.ts`・`field-sign-dup.test.ts`（mutation 7 通り検出）。
- [ ] **【まとめ】キー編集の細部が ACS と違う**（優先度 中〜低・深さ △・一部**要判断（方針）**）。
  委譲先 D が両側を読んで挙げたもの。**着手時に ACS 側・当 PJ 側の両方を再確認すること。**
  - ~~RB/RZ 欄のフィールド終了（中）~~ → 上の `20260921-field-exit-required-types` で済んだ
    - ACS: RB/RZ 欄も Field Exit が必須（`Field5250.isFieldExitRequired`）。
    - 当 PJ: FER ビットしか見ない（`packages/tn5250/src/screen/buffer.ts:1225`）ので、満杯になると次の欄へ自動で送り、AUTO_ENTER なら Enter を送る。
  - ~~欄を出ないまま AID を押したとき（中・**方針決定済み：ACS と同じくエラー**）~~ → 上の `20260921-aid-without-field-exit` で済んだ
    - **方針（利用者の判断・2026-09-21）: ACS と同じく操作員エラー 0020 にして送らない。**
    - ACS: 右寄せ欄・符号付き数値欄ではエラー 0020 にする（`PS5250.processAIDCode`）。
    - 当 PJ: 左詰めのまま送る。英数字の CHECK(RZ)/(RB) 欄には左詰めのまま格納される。
  - Home（中・**要判断**）
    - ACS: 画面のホーム位置（IC、無ければ先頭の非バイパス欄）へ移る。既にそこにいれば Record Backspace を送る。
    - 当 PJ: 欄の先頭へ移る（`ScreenGrid.vue:2682`）。
  - Backtab（中）
    - ACS: 欄の途中なら、その欄の先頭で止まる。カーソル送り（FCW 0x88）を逆向きにたどる（`FFT5250.previousNonByPassInputFieldPos`）。
    - 当 PJ: 常に前の停止点へ移る。`EmulatorPane.vue:356-369` の「ACS で確かめられない」という前提は崩れた。
  - ~~ME/MF の意味とタイミング（中〜低・**要判断**）~~ → 上の `20260921-mandatory-check-acs` で済んだ
    - ACS: ME を内容ではなく MDT で判定し、画面に変更が無ければ検査しない。CF キーや Roll でも検査する。MF と自己点検は、欄を出るときにも検査する（`PS5250.processAIDCode`・`FFT5250.checkMandatoryFieldCheck`）。
    - 当 PJ: Enter のときだけ、内容で判定する（`mandatoryCheck.ts`）。Enter のときだけにしたのは、`20260729-ffw-behavior-bits` D1 の意図的な差異。
  - テンキーの ±（中〜低）
    - ACS: すべての欄で Field+ / Field− として働く。
    - 当 PJ: 数値欄でだけ働く（`signKeyHack`）。キー割り当てで、テンキーの − とメイン行の - を区別できない（`keybindings.ts:174`）。
  - 低
    - 欄の先頭での Backspace、End の行き先
    - Clear / Help / Print / PA で欄データを送る
    - Field− の可否、数値専用欄での Field−
    - 符号付き＋RZ の埋め字、右寄せで動かす範囲
    - Dup（FER 欄・継続欄）、継続欄での Field Exit / Erase EOF、Field Exit 時の検査
    - MONOCASE で ASCII 以外を大文字化しない
    - 未対応の機能: ~~Reset~~（`20260921-operator-error-mode` で実装）・Field Mark・PA1〜3・Record Backspace・Test Request・Erase Field・SOH の「入力欄だけ移動」・欄の再順序付け
    - 既定のキー割り当ての違い: ~~左 Ctrl=Reset~~（揃えた）、Esc=Attn、Shift+Insert=Dup ほか
    - ~~`opMessages.ts:215/217` の「0021/0022 相当」の番号の誤り（ACS では、AID 時の ME は 0007、MF は 0014）~~ → 直した（`20260921-mandatory-check-acs`）
  - 裏付けが取れた記録: 930/5026 で全欄を大文字化する（`20260729-ffw-behavior-bits` D2 で「未確認」とされていた）は、`CodePage.toUpper` で裏付けられた。
  （出典: `20260919-backlog-acs-triage` research N13・F5、`20260919-backlog-acs-triage` の `acs-comparison.md` 領域 2）
- [x] **【まとめ】DS5250 のその他の差のうち、画面イメージ応答**（優先度 中）
  **完了（`20260920-restore-screen-parity`・PR #407）**。DSM（`QsnPutInpCmd(0x66)`）で実機に出させ、
  `scripts/tap-proxy.mjs` 越しに **ACS の応答と突き合わせて**決着させた。
  - ~~到達するかは要実測~~ → **`0x66` は到達する**（`READ SCREEN TO PRINT`。国勢調査 2 回で
    `0x62` は 1 件も届かないが、`0x66` / `0x6A` / `0x62` は**同じ `buildReadScreenResponse` を共有**する）
  - 差は 3 点で、どれも ACS に合わせた: **opcode は受信の写し**（`0x08`。従来は `PUT_GET` 固定）／
    **カーソル 2 バイトの前置を外す**／**未書き込み桁は `0x00`**（従来は `0x40`）
  - 打鍵した文字も載るようにした（`writeCell` が `rawByte ?? hostByte ?? encodeSbcs(char)`）。
    オーダー 0x1C / 0x1E と `UNMAPPABLE` は**受信した元バイト**で返す（表示用の `rawByte` とは別に
    送信用の `hostByte` を持たせた）。制御文字は属性帯に化けないよう `0x40` に倒す
  - **実測で ACS と一致**: 1,930 バイト・opcode `0x08`・本体先頭 `3a d4 c1 c9 d5 00 00 00 00 00`。
    ホストも受理（`rc=1024`）
  - **未確認**: `0x62` 固有の扱い（ACS は `processReadScreen(false)` で上位バイトの立った桁を
    8 ビット右へ送る。当 PJ にはそのプレーン表現が無いので**対応物も無い**）／
    `READ IMMEDIATE`(0x72) と `READ MDT IMMEDIATE ALT`(0x83) の opcode は `PUT_GET` 固定のまま
- [ ] **【まとめ】DS5250 のその他の差（画面イメージ応答を**除く**）**（優先度 低・深さ △・WEA タイプ 5 だけ ○）。
  **着手時に両側を再確認すること。**
  - WEA タイプ 5（拡張 NLS 区間）（○）
    - ACS: DBCS セッションでは適用する（`PS5250.writeExtAttribute`）。
    - 当 PJ: すべてのタイプを読み飛ばす（`wtd-applier.ts:555-575`）。
    - 実機のトレースでは未観測。
  - 細部の差
    - ROLL の空いた行: ACS は旧内容を残し、当 PJ は空白にする。
    - CLEAR 系の付随処理: CA マスク・メッセージ行・保留中の READ・`msgLineRow` の初期化をしない。画面サイズが変わっても罫線を残す。
    - WSF D9/72 に応答しない。WDSF 0x52/0x54/0x55、FCW 0x80xx/0x84xx が未対応。
    - 負応答を返さない。
    - 0x82/0x83 の欄データで、NUL と符号を加工する。
  - 注意: CFR の出力は、`DS5250.processWriteErrorCode` の中の `processWriteToDisplay` の呼び出しが欠落している。見た目が不自然な箇所は、`javap -c` で確かめる。
  （出典: `20260919-backlog-acs-triage` research N14・F4 の低、委譲先 C）
- [ ] **【まとめ】telnet・自動サインオン・装置名の差**（優先度 中〜低・深さ △・IBMRSEED だけ ◐）。
  **着手時に両側を再確認すること。**
  - IBMRSEED の書式（中）
    - 当 PJ: `ESC 00` の後に、エスケープしない `00` を 7 個送る（`packages/tn5250/src/telnet/telnet.ts:250-253`、主エージェントが確認）。RFC 1572 では空の VAR が 7 個と読まれる。
    - ACS: 平文モードでは値を付けない（`NVT5250.insertVariable` の case 22）。
    - PUB400 と実機では通っている。
  - 装置名（中）
    - ACS: 置換記号（`*` `%` `=` `+` `&COMPN` など）を展開し、大文字にする（`AutoDeviceName5250`）。
    - 当 PJ: 書いたとおりに送る。
    - `deviceNameRetry` は理由を問わずに再試行するので、誤ったパスワードで QMAXSIGN を使い切る恐れがある（推測）。
  - 1399 の申告（中・要実測）
    - ACS: KBDTYPE=JPE・CHARSET=32000。
    - 当 PJ: JEB・1172（`packages/base/src/device-env.ts:42`）。
  - DBCS 24x80 の端末タイプ（中・要実測）
    - ACS: `IBM-5555-C01`。
    - 当 PJ: `IBM-5555-G02`（`terminal-type.ts:25`。PUB400 での総当たりで採用した）。
  - 低
    - 関連プリンター（IBMASSOCPRT）が未対応
    - 交渉前に届くテキストを出さない
    - USER とパスワードを正規化しない
    - 拒否理由を英語で出す（AGENTS.md の「利用者に見える文言は日本語」にも触れる）
    - 起動応答の見分け方と、装置名の復号（ACS は CP037 固定）
    - バックアップホストが無い
    - telnet のオプションの状態機械（実害なし）
    - NEW-ENVIRON の応答方式（実害なし）
  （出典: `20260919-backlog-acs-triage` research N17・F4 の低、`20260919-backlog-acs-triage` の `acs-comparison.md` 領域 3）
- [ ] **【まとめ】SCS の解釈の差**（優先度 中〜低・深さ △）。
  **着手時に両側を再確認すること。**
  - 1 バイトの制御（中・安い）
    - ACS が解釈する LF(0x25)・IR(0x33)・IRS(0x1E)・TRN(0x35)・BS(0x16) などを、当 PJ は印字文字として桁に置く（`packages/scs/src/scs.ts:48-59, 201-212`）。
    - 0x40 未満の未知の制御を印字しないだけでも効く。
  - 0x2B オーダーの消費長（中）
    - ACS: 長さの前置を見て、汎用に読み飛ばす。
    - 当 PJ: 2BC1/C2/C6 を固定長で読む。2BD1 の SCG や 2BFE（LAC）などを未知として扱い、**帳票の残りを打ち切る**（`scs.ts:249-308`）。
  - SO/SI の桁（中・要実測）
    - ACS: 既定では 1 桁の空白として描く。SPCC で切り替わる。日本語の実機は `2B FD 04 03 00 01` を送ってくる。
    - 当 PJ: 0 桁（`spool-html.ts:141-146`。PUB400 での観察で決めた）。
  - 低
    - 重ね打ち（CR だけで行頭へ戻る）
    - 書式オーダー（SPPS・SHM・SVM・SCD・SLD・SHT）
    - ~~ジョブ終了の判定（ACS はヘッダの byte7=0x08、当 PJ は長さ 17）~~ → `20260921-printer-acs-declaration` で揃えた
    - ~~印刷完了応答のバイト 4-5~~ → 同上（0x0102）
    - プリンターの既定値（意図的な差異）
  （出典: `20260919-backlog-acs-triage` research N16・F4 の低、`20260919-backlog-acs-triage` の `acs-comparison.md` 領域 3）
