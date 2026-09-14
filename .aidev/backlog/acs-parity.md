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
- [ ] DSPFMT でフィールドのオプション入力欄の下線が消えたり、罫線のみ表示されることがある（利用者報告、20260915）。再現条件・原因未特定。ACS の該当描画ロジックとの突き合わせが有効な可能性が高い（acs-parityの主題そのもの）。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md）
- [ ] SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を維持する、という当初のAC1/AC2/AC8の目標（20260914-seu-page-cursor-hold で撤去済み）。ACS のコア（DS5250/PS5250）には専用ロジックが見当たらなかったため、UI描画層の調査や実機同時比較（tap-proxy.mjs等）で「ACSが実際にどう見せているか」を先に確定してから再挑戦する。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md）
- [ ] 当プロジェクト全体でACSの実装と突き合わせるべき挙動の棚卸し（利用者から「全体的にACSを手本に見直しを図ってください」との要望、20260915）。スコープが大きいため、まず対象範囲の絞り込み（優先度の高い画面・操作から）を requirements として起こすところから始める。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md）
