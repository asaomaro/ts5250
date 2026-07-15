# 決定記録（親 work）

## D2: 〔2026-07-15 改訂〕D1 を撤回し、GUI コントロール(06)・リンク化(07)を本 PR の subtask とする

- ユーザー指示により、拡張 5250 GUI コントロールと画面テキストのリンク化を **follow-up ではなく subtask 06/07
  として同一 PR にまとめる**。親 subtasks に 06-gui-controls・07-screen-links を追加し、05 完了後に着手する。
  統合 test はその後に実施する。D1 の「別 PR」方針は撤回。

## D1: 拡張 5250 GUI コントロールと画面テキストのリンク化（当初 follow-up 案・D2 で subtask 化に撤回）

- 背景: 05 review 時にユーザーから追加要望。(1) DSPF の DDS 定義による GUI コントロール
  （SNGCHCFLD=ラジオ / MLTCHCFLD=チェック / PSHBTNFLD=プッシュボタン / WINDOW / MNUBAR /
  スクロールバー等。ワイヤ上は拡張 5250 の WSF GUI 構造体コマンド）。(2) 画面テキストのメール→mailto・
  URL→リンク化。
- 現状: WSF は QUERY（0xD9/0x70）のみ検出し他の GUI 構造体は読み飛ばし、Query Reply で enhanced 5250 を
  「非対応」と広告している（`query-reply.ts` t[53]=0x00）。GUI コントロールは非対応。
- 決定: 基本エミュレータ（SBCS/DBCS/TLS/MCP/Web/フィールド編集）の 5 subtask を先に統合 test→review→
  deliver で**着地（PR 化）**し、以下は**次の作業（別 PR）**として着手する。
  - **06: 拡張 5250 GUI コントロール**（大規模）: Query Reply で enhanced 広告 → Define Selection Field /
    Create Window / Define Scroll Bar 等の WSF GUI 構造体を解析 → HTML コントロール描画 → 入力送信。
    参照は GNU tn5250 の define_selection_field / create_window_structured_field / define_scrollbar。
  - **07: 画面テキストのリンク化**（小規模・Web のみ）: 画面テキスト中のメール→mailto、URL→`<a>` リンク化。
- 理由: GUI コントロールは実質もう一つのフェーズ規模。親 PR を「基本エミュレータ」として一貫させ、
  拡張機能を独立 PR にする方が着地・レビューが締まる（ユーザー選択）。
