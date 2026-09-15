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
  - [ ] DSPFMT そのものの再現・原因特定は未達のまま（`20260914-dspfmt-field-underline-instability` decisions.md D1）。実機に RPG コンパイル用のソースファイル（`QRPGLESRC`）が現在ASAOLIBに無く、黄・青緑以外の色での桁区切り(DSPATR(CS))の実際の送信経路（WEA経由か等）を実行時に確認できなかった（DDSコンパイル自体は全7色で通ることは確認済み、`build-colsep-matrix.mjs`）。次はソースファイルの整備可否を利用者に確認するか、利用者の実機で直接トレースを取ることから始める。（出典: .aidev/works/20260914-dspfmt-field-underline-instability/research.md, decisions.md）
- [x] ~~SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を維持する~~、という当初のAC1/AC2/AC8の目標（20260914-seu-page-cursor-hold で撤去済み）。~~ACS のコア（DS5250/PS5250）には専用ロジックが見当たらなかったため、UI描画層の調査や実機同時比較（tap-proxy.mjs等）で「ACSが実際にどう見せているか」を先に確定してから再挑戦する。~~ ——利用者からの新規報告（保護欄にカーソルを置いたまま PageUp/PageDown するとヘッダーの入力可能エリアへ強制移動する、ACSは変わらない）を受けて再調査した結果（`20260915-pdm-protected-cursor-pageup`）、上記の前提は2点とも誤りだったと判明した。(1) 症状は境界ページに限定されない（実機トレースで非境界ページでも再現、`research.md` F4/F5）。(2) 原因は ACS 側の未知ロジックではなく、**当プロジェクト既存の分岐（PR#387、`cursorAddr === cursorBefore && cursorIsUnenterable()` → 先頭入力欄へ寄せる）が PageUp/PageDown 応答で誤発火していたこと**——ACS の UI層調査は不要だった。修正: `lastSentAid`（直前に送信したAIDキー）を再導入し、PageUp/PageDown の応答でのみ既存2分岐（`PR#387`分岐・`!cursorSet`分岐）を除外する（`decisions.md` D2-D4）。修正後のビルドで実機（SR-OSAKA/ASAOLIB）の境界・非境界両ケースにおいてカーソル位置が維持されることを確認済み（`research.md` F6）。回帰テスト: `packages/tn5250/test/cursor-stale-on-protected.test.ts`。（出典: `.aidev/works/20260915-pdm-protected-cursor-pageup/research.md`, `decisions.md`）
- [x] 当プロジェクト全体でACSの実装と突き合わせるべき挙動の棚卸し（利用者から「全体的にACSを手本に見直しを図ってください」との要望、20260915）のうち、**第1弾（プロトコル仕様そのものの突き合わせ、ACS・実機起動どちらも不要）**を実施した（`20260915-acs-protocol-order-audit`）。ACS のデコンパイル済みコア（`DS5250.processWriteToDisplay()`のオーダーswitch、`PS5250.addChar()`の文字書き込み処理）と `wtd-applier.ts` を突き合わせ、オーダー対応は1:1で一致していることを確認。あわせて `ORDER.UNKNOWN_1C`（0x1C）の対（0x1E）に専用の`case`が無く、遭遇すると同一WTD内の以降の全オーダーが失われる欠陥を発見・修正した（`ORDER.UNKNOWN_1E`追加、`packages/tn5250/test/wtd-applier.test.ts`に回帰テスト追加）。残作業は下記に割る。
  - [ ] 見た目のヒューリスティックの是非（利用者の実機操作＝ACS起動が必要）、および DSPFMT の再現待ち（利用者の実機ライブラリへの変更判断が必要）は未着手のまま。
    **絞り込みの叩き台（20260915、旧記述を残す）**:
    2. **[利用者の実機操作が必要] 見た目のヒューリスティックの是非**: ~~SEU の PageUp/PageDown 境界カーソル（本ファイル上の項目）のような~~「ACS のコアには専用ロジックが無いが見た目で挙動が違って見える」ケース。**訂正（`20260915-pdm-protected-cursor-pageup`）**: 上記の例（SEU の PageUp/PageDown 保護欄カーソル）は、実際には ACS 側の未知ロジックではなく当プロジェクト既存の分岐（PR#387）の誤発火が原因だったと判明し、ACS の UI層調査無しで解決済み（本ファイル上の該当項目参照）——このカテゴリの**例としては不適切**だったが、カテゴリ自体（ACS のコアに専用ロジックが無いのに見た目が違って見える、未解決のケース全般）は依然として残りうる。ACS の UI 描画層（コアのデコンパイルでは追えなかった）に踏み込むか、`tap-proxy.mjs` で利用者に ACS を実際に起動してもらい実機と同時比較するかのいずれかが要る——**この work だけでは実行できず、利用者の協力（ACS 起動・実機操作）が前提**。
    3. **[利用者の実機ライブラリへの変更判断が必要] DSPFMT の再現待ち**: 本ファイル上の別項目。`QRPGLESRC` 整備の可否を利用者に確認してから。
    次に着手する際は `20260915-acs-protocol-order-audit` の decisions.md D1（`ORDER.UNKNOWN_1C`/`UNKNOWN_1E` のアーキテクチャ上の位置づけの見直しは今回scope外とした）も参照。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md, .aidev/works/20260915-acs-protocol-order-audit/decisions.md）
