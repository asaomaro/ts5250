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
- [ ] SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を維持する、という当初のAC1/AC2/AC8の目標（20260914-seu-page-cursor-hold で撤去済み）。ACS のコア（DS5250/PS5250）には専用ロジックが見当たらなかったため、UI描画層の調査や実機同時比較（tap-proxy.mjs等）で「ACSが実際にどう見せているか」を先に確定してから再挑戦する。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md）
- [ ] 当プロジェクト全体でACSの実装と突き合わせるべき挙動の棚卸し（利用者から「全体的にACSを手本に見直しを図ってください」との要望、20260915）。スコープが大きいため、まず対象範囲の絞り込み（優先度の高い画面・操作から）を requirements として起こすところから始める。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md）
  - **絞り込みの叩き台（20260915、2件の調査（seu-page-cursor-hold・dspfmt-field-underline-instability）を踏まえた分類）**:
    1. **[即着手可・ACS 不要] プロトコル仕様そのものの突き合わせ**: `tap-proxy.mjs`（利用者側での ACS 起動）や実機の応答有無に頼らず、ACS のデコンパイル済みコア（`DS5250`/`PS5250`。解析済みだが `decisions.md` 記載の抽出物は整理済みのため要再デコンパイル。`acsbundle.jar` は `/mnt/c/tool/IBMiAccess_v1r1/`）とこのリポジトリの `wtd-applier.ts`/`read-response.ts` 等を1オーダーずつ突き合わせる机上調査。`dspfmt-field-underline-instability` で見つかった WEA（0x12）のような「未実装のまま default: に落ちているオーダー」が他に無いか、`constants.ts` の `ORDER`/`COMMAND` 定義済みだが switch に `case` の無いものを機械的に洗い出すところから始めると効率的。**最も着手しやすい**（実機・ACS 起動のどちらも不要）。
    2. **[利用者の実機操作が必要] 見た目のヒューリスティックの是非**: SEU の PageUp/PageDown 境界カーソル（本ファイル上の項目）のような「ACS のコアには専用ロジックが無いが見た目で挙動が違って見える」ケース。ACS の UI 描画層（コアのデコンパイルでは追えなかった）に踏み込むか、`tap-proxy.mjs` で利用者に ACS を実際に起動してもらい実機と同時比較するかのいずれかが要る——**この work だけでは実行できず、利用者の協力（ACS 起動・実機操作）が前提**。
    3. **[利用者の実機ライブラリへの変更判断が必要] DSPFMT の再現待ち**: 本ファイル上の別項目。`QRPGLESRC` 整備の可否を利用者に確認してから。
    - **推奨する着手順**: 1 → （利用者の都合がつき次第）2・3。1 は次に requirements を起こす際、そのまま「対象範囲」の初期スコープとして使える。
