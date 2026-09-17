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
  - [ ] 黄・青緑以外の色での桁区切り(DSPATR(CS))の実際の送信経路（WEA経由か等）は
    引き続き未確認のまま（`20260914-dspfmt-field-underline-instability` decisions.md D1）。
    実機に RPG コンパイル用のソースファイル（`QRPGLESRC`）が現在ASAOLIBに無く、実行時の
    確認ができなかった（DDSコンパイル自体は全7色で通ることは確認済み、
    `build-colsep-matrix.mjs`）。次はソースファイルの整備可否を利用者に確認するか、
    利用者の実機で直接トレースを取ることから始める。（出典:
    .aidev/works/20260914-dspfmt-field-underline-instability/research.md, decisions.md）
- [x] ~~SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を維持する~~、という当初のAC1/AC2/AC8の目標（20260914-seu-page-cursor-hold で撤去済み）。~~ACS のコア（DS5250/PS5250）には専用ロジックが見当たらなかったため、UI描画層の調査や実機同時比較（tap-proxy.mjs等）で「ACSが実際にどう見せているか」を先に確定してから再挑戦する。~~ ——利用者からの新規報告（保護欄にカーソルを置いたまま PageUp/PageDown するとヘッダーの入力可能エリアへ強制移動する、ACSは変わらない）を受けて再調査した結果（`20260915-pdm-protected-cursor-pageup`）、上記の前提は2点とも誤りだったと判明した。(1) 症状は境界ページに限定されない（実機トレースで非境界ページでも再現、`research.md` F4/F5）。(2) 原因は ACS 側の未知ロジックではなく、**当プロジェクト既存の分岐（PR#387、`cursorAddr === cursorBefore && cursorIsUnenterable()` → 先頭入力欄へ寄せる）が PageUp/PageDown 応答で誤発火していたこと**——ACS の UI層調査は不要だった。~~修正: `lastSentAid`（直前に送信したAIDキー）を再導入し、PageUp/PageDown の応答でのみ既存2分岐（`PR#387`分岐・`!cursorSet`分岐）を除外する（`decisions.md` D2-D4）。~~ ~~訂正（deliver後、利用者指摘を受けた再検証。`decisions.md` D5）: AIDキー種別による判定は、たまたま検証した2ケースの相関にすぎず真の判別軸ではなかった。ACSのデコンパイル済みコアにキー種別による分岐は無く（`20260914-seu-page-cursor-hold` decisions.md D6）、真の判別軸は「このレコードを当てる前、その桁は入力可能だったか」（`cursorBeforeWasEnterable`）だった——`PR#387`分岐にのみこの条件を追加し、`!cursorSet`分岐は無条件（元の形）に戻した。`lastSentAid`は撤去。~~ **再訂正（`20260915-pr387-acs-premise-unverified`）**: `cursorBeforeWasEnterable` 自体も撤去された——`PR#387`分岐そのものが、未検証の前提（「ACSは下の入力欄にカーソルを入れる」）に基づいていたと判明し、分岐ごと撤去したため（下記の新規項目を参照）。結果として、SEU の PageUp/PageDown の症状はこの分岐撤去の副産物として解消された（`cursorBeforeWasEnterable` という条件分岐を経由せず、単純にホストのIC/MC指定に常に従う形になったため）。修正後のビルドで実機（SR-OSAKA/ASAOLIB）の境界・非境界両ケース（SEU）と`PR#387`元シナリオ（CURSORCL3、`PGM=CURSORCL3`）の両方でカーソル位置が正しく判定されることを確認済み（`.aidev/works/20260915-pr387-acs-premise-unverified/research.md` に実機再確認の記録あり）。回帰テスト: `packages/tn5250/test/cursor-stale-on-protected.test.ts`。（出典: `.aidev/works/20260915-pdm-protected-cursor-pageup/research.md`, `decisions.md`、`.aidev/works/20260915-pr387-acs-premise-unverified/research.md`, `decisions.md`）
- [x] **`PR#387`（コミット `c82e2b34`、保護欄でEnter確定後にカーソルを先頭入力欄へ寄せる、既にmainにマージ済み）の前提が未検証だったと判明し、分岐を撤去した**（`20260915-pr387-acs-premise-unverified`）。利用者から「ホストが位置を送ってくるならキー種別に関係なくホストに従えば良いのでは。ACSのjarにキー判定があるのか」との指摘、続いて「CURSORCL3でACSが下の入力欄へ寄せる、というのはこちらの報告だったか？誤報告かもしれない」との指摘を受けて調査した。判明した事実: (1) `PR#387`（GitHub PR #387）の検証資材は全てこのプロジェクト自身のクライアントが対象で、実際のACSソフトウェアには一度も接続していない。(2) PR本文の確認チェックリスト「報告された実際の画面で、Enter後に下の入力欄へ入ること」が未チェックのまま残っていた。(3) ACSのデコンパイル済みコア（`DS5250.preprocessWCC2()`）の全文を読んだ結果、カーソル位置の決定はIC/MCの有無だけで完結しており（GUI選択ウィジェット専用の狭い例外を除く）、この上書きに相当するロジックは存在しなかった。(4) 利用者自身も「当時ACSと比較した記憶は不確か」と回答。対応: `handleRecord()`から`PR#387`分岐と専用ヘルパー（`buffer.ts`の`isEnterableAt`/`cursorIsUnenterable`）を削除し、ACSコアの確認済み挙動（IC/MCの指定に常に従う）に一致させた。これにより、`PR#387`が元々解決しようとした症状（Enter確定後、保護化された欄にカーソルが取り残されTabを押すまで入力できない）は再び起きる——ACSコアの確認済み挙動に合わせるための意図的な変更であり、単純な退行ではないが、**実機ACSによる直接確認はこの work でも引き続きできていない**（~~この開発環境にACSが無いため~~ ——訂正（2026-09-17）: 誤り。下の子項目の訂正を参照）。もし将来、実機同時比較で「ACSは実際にCURSORCL3で下の欄へ寄せる」ことが確認された場合は、この変更を差し戻し、真の判別軸を実機で確認した上で`PR#387`相当の分岐を再実装する必要がある。（出典: `.aidev/works/20260915-pr387-acs-premise-unverified/research.md`, `decisions.md`）
  - [ ] **実機ACSによる直接比較が今後も課題として残る**（~~利用者の協力が前提。~~`tap-proxy.mjs`等での実機同時比較）。特にCURSORCL3のシナリオ（Enter確定後の保護化）でACSが実際にどう振る舞うかは、今回も確認できていない。（出典: `.aidev/works/20260915-pr387-acs-premise-unverified/decisions.md` D2）**訂正（2026-09-17）**: 「この開発環境にACSが無い」は誤りで、ACSのjar（`acshod2.jar`）をそのまま使う 5250-operator MCP と `scripts/tap-proxy.mjs` で実測比較できる。実際に PA0100J（Enter 後・PageUp 後のカーソル）と YB0140R（窓の PageUp/PageDown）はこの方法で ACS と突き合わせて是正した（PR #404。IC/MC の WTD 単位確定・SOH での破棄・WEC でのカーソル復元・窓左端の属性打ち切り。`packages/tn5250/src/protocol/wtd-applier.ts` の `PendingCursorOrder`、回帰テスト `packages/tn5250/test/cursor-per-wtd.test.ts`）。**CURSORCL3 のシナリオだけは未実測のまま**なので、この項目は開けておく。
- [x] 当プロジェクト全体でACSの実装と突き合わせるべき挙動の棚卸し（利用者から「全体的にACSを手本に見直しを図ってください」との要望、20260915）のうち、**第1弾（プロトコル仕様そのものの突き合わせ、ACS・実機起動どちらも不要）**を実施した（`20260915-acs-protocol-order-audit`）。ACS のデコンパイル済みコア（`DS5250.processWriteToDisplay()`のオーダーswitch、`PS5250.addChar()`の文字書き込み処理）と `wtd-applier.ts` を突き合わせ、オーダー対応は1:1で一致していることを確認。あわせて `ORDER.UNKNOWN_1C`（0x1C）の対（0x1E）に専用の`case`が無く、遭遇すると同一WTD内の以降の全オーダーが失われる欠陥を発見・修正した（`ORDER.UNKNOWN_1E`追加、`packages/tn5250/test/wtd-applier.test.ts`に回帰テスト追加）。残作業は下記に割る。
  - [ ] 見た目のヒューリスティックの是非（利用者の実機操作＝ACS起動が必要）、および DSPFMT の再現待ち（利用者の実機ライブラリへの変更判断が必要）は未着手のまま。
    **絞り込みの叩き台（20260915、旧記述を残す）**:
    2. **[利用者の実機操作が必要] 見た目のヒューリスティックの是非**: ~~SEU の PageUp/PageDown 境界カーソル（本ファイル上の項目）のような~~「ACS のコアには専用ロジックが無いが見た目で挙動が違って見える」ケース。**訂正（`20260915-pdm-protected-cursor-pageup`）**: 上記の例（SEU の PageUp/PageDown 保護欄カーソル）は、実際には ACS 側の未知ロジックではなく当プロジェクト既存の分岐（PR#387）の誤発火が原因だったと判明し、ACS の UI層調査無しで解決済み（本ファイル上の該当項目参照）——このカテゴリの**例としては不適切**だったが、カテゴリ自体（ACS のコアに専用ロジックが無いのに見た目が違って見える、未解決のケース全般）は依然として残りうる。ACS の UI 描画層（コアのデコンパイルでは追えなかった）に踏み込むか、`tap-proxy.mjs` で利用者に ACS を実際に起動してもらい実機と同時比較するかのいずれかが要る——**この work だけでは実行できず、利用者の協力（ACS 起動・実機操作）が前提**。
    3. **[利用者の実機ライブラリへの変更判断が必要] DSPFMT の再現待ち**: 本ファイル上の別項目。**訂正（`20260915-dspfmt-reconnect-blank-redraw`）**: 利用者からの新しい再現手順を得て再現・原因特定に成功し、`QRPGLESRC` 整備を待たずに解決した（本ファイル上の該当項目参照）——ただし色符号化（DSPATR(CS)）に関する別のサブ課題は `QRPGLESRC` 整備待ちのまま残っている。
    次に着手する際は `20260915-acs-protocol-order-audit` の decisions.md D1（`ORDER.UNKNOWN_1C`/`UNKNOWN_1E` のアーキテクチャ上の位置づけの見直しは今回scope外とした）も参照。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md, .aidev/works/20260915-acs-protocol-order-audit/decisions.md）
- [x] 当プロジェクト全体でACSの実装と突き合わせるべき挙動の棚卸し（利用者から「全体的にACSを手本に見直しを図ってください」との要望、20260915）のうち、**第2弾（フィールド入力値検証`field-validate.ts`の突き合わせ、ACS・実機起動どちらも不要）**を実施した（`20260915-acs-field-validation-audit`）。ACSのデコンパイル済みコア（`Field5250`の`checkNumericOnlyChar()`・`checkDigitsOnlyChar()`・`checkAlphaOnlyChar()`・`checkKanaShiftChar()`）と`field-validate.ts`を突き合わせ、数値専用欄（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）で埋め込みの空白文字を拒否していた食い違いを発見・修正した（ACSは位置を問わず空白を許容する。正規表現を`/^[0-9.,+-]*$/`→`/^[0-9 .,+-]*$/`に変更、回帰テスト`packages/tn5250/test/field-validate.test.ts`）。数字のみ・英字専用・カタカナシフトの検証は既に一致していることを確認済み。残作業は下記に割る。
  - [x] **自己点検欄（モジュラス10/11、FCW経由で付与される属性）~~が当プロジェクトに未実装~~**（`20260915-acs-field-validation-audit` decisions.md D2）。ACSの`Field5250.checkModulusField()`/`modulusCheck()`が標準的なモジュラス10/11アルゴリズムを実装しているが、当プロジェクトの`wtd-applier.ts`は未知のFCWを安全に読み飛ばすためパース破壊は起きない（feature gapでありbugではない）。実装を見送った理由: (1) 正確なFCW値（~~`0xB0xx`/`0xB1xx`系と推測されるが未確定~~）がデコンパイル結果だけからは一意に確定できず、実機トレースが必要。(2) モジュラス10/11の検証はフィールド全体の最終値に対して行うもので、既存の「打鍵・貼り付けされた差分文字を1文字ずつ検証する」という`validateFieldContent()`の構造とは粒度が異なり、別途フィールド確定時検証を新設する設計が要る。次に着手する際は、実機で自己点検欄付きの画面を作り生バイトを採取して正確なFCW値を確認することから始める——アルゴリズムの詳細は`.aidev/works/20260915-acs-field-validation-audit/research.md` F6に記録済み。（出典: .aidev/works/20260915-acs-field-validation-audit/research.md, decisions.md） **実装済み（2026-09-17・PR #404）**: FCW は ACS `Field5250` の定数（`javap -constants`）で確定した——`FCW_SELF_CHECK_MODULUS_11=0xB140` / `FCW_SELF_CHECK_MODULUS_10=0xB1A0`。`wtd-applier.ts` の `applySf` が `Field.selfCheck`（`mod10`/`mod11`）として載せ、検算は `Field5250.checkModulusField()`/`modulusCheck()` を写した `selfCheckDigitOk`（`packages/tn5250/src/screen/field-validate.ts`）。粒度の問題（上記 (2)）は、差分文字の検証ではなく **AID 送信前の検査**（web-ui `composables/mandatoryCheck.ts`、`MANDATORY_ENTER`/`MANDATORY_FILL` と同じ場所）に置くことで解いた——ACS も送信時に検算する。回帰テスト: `packages/tn5250/test/fcw-dbcs-self-check.test.ts`・`packages/web-ui/test/self-check-field.test.ts`。同時に DBCS の FCW を ACS の 4 値（`0x8200`=only/`0x8220`=pure/`0x8240`=either/`0x8280`=open）へ揃えた。
