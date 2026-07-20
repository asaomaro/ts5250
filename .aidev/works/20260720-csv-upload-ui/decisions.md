# 決定記録

## D1: アップロード専用ペインをやめ、取得と取り込みを持つ「データ転送」ペインにする

- 背景: coding 着手直後（T1 実装中）に、ユーザーから「アップロード画面は SQL アプリと共通か」と問われた。
  当初の design は `UploadPane.vue`（`upload:table`）という**取り込み専用**の新規ペインで、
  取得（CSV ダウンロード）は既存の SQL ペインに残したままだった。
  ユーザーの指摘は「SQL アプリは ACS の **Run SQL Scripts** の位置づけなので、
  取得と取り込みをまとめた **Data Transfer** 相当のアプリにすべきではないか」。
- 決定: `TransferPane.vue`（タブ ID `transfer:data`）とし、**方向切替（取得 ⇄ 取り込み）を持つ 1 つのアプリ**にする。
  SQL ペインは Run SQL Scripts のまま据え置き、実行結果の CSV エクスポートも残す。
- 理由 / 代替案:
  - 当初案は**実装の現状**（「ダウンロードは既に SQL ペインにある」）から出発しており、
    概念ではなく既存コードの都合で境界を引いていた。結果として取り込みだけが別ペインという非対称になっていた。
  - ACS でも SQL 結果のエクスポートは Run SQL Scripts 側にあり、専用の Data Transfer と共存している。
    よって「SQL ペインの CSV ダウンロードを残す」ことと「データ転送アプリを作る」ことは矛盾しない。
  - 退けた案: SQL ペインに取り込みモードを統合する。SqlPane は既に 696 行あり、
    流れ（SQL を書く / ファイルを投入する）も別物。境界が曖昧になる。
- 影響:
  - **core / server の設計は変更なし**。事前検査・バッチ書き込み・CSV 解析・API はそのまま使える。
  - design.md の UI 節、spec.md の対象範囲、tasks.md の web-ui タスクを更新。
  - 取得側はサーバーの新規実装が不要（既存 `POST /api/host/sql` に組み立てた SELECT を投げる）。
    ただしライブラリ名・表名の検証は取り込み側と同じ関数を使う。
  - 経緯: coding → design への差し戻し（`aidev event coding sent_back` → `aidev event design start`）。
    デザイン案を HTML モックで提示し、承認を得てから再開した。
