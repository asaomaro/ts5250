# 調査: サーバー側 PDF/印刷の実現性（環境確認）

## 判明した事実
- **F1 PDF ライブラリ**: `pdfkit` 0.19.1 を server ワークスペースに追加でき、動作を確認
  （TTF/OTF 埋め込み対応。ネットワーク導入可）。
- **F2 CJK 等幅フォント**: システムに **Noto Sans Mono CJK JP** がある
  （`/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`、postscript 名 `NotoSansMonoCJKjp-Regular`）。
  **等幅かつ Latin（半角）＋日本語（全角＝半角2倍）を 1 フォントで賄える**→ 帳票グリッドをそのまま
  再現できる。スモークで「TESTLIB … 日本語テスト」を 58KB の正常 PDF に描画確認（半角 advance=5pt@10）。
  - フォント名指定の注意: `.ttc` はコレクションなので postscript 名（`NotoSansMonoCJKjp-Regular`）で選ぶ。
    「Noto Serif CJK JP」等の表示名では pdfkit がロードに失敗する。
  - フォント欠落時は標準 Courier にフォールバック（SBCS のみ。DBCS は警告して degrade）。
- **F3 OS 印刷**: この環境に `lp`/`lpr` は**無い**。自動印刷はコード実装のみ可能で、実運用（lp のある
  サーバー）でのみ有効＝この環境では実行テスト不可。`lp -d <printer> <file>` を child_process で呼ぶ。
  lp 不在時は警告して no-op（degrade）。
- **F4 出力形式（論理ページ→PDF）**: `ScsDecoder` は既に `LogicalPage[]`（等幅グリッド・改ページ）を出す。
  Noto Sans Mono CJK は等幅なので、**各ページの `lines[]` を行ごとに描画**すれば桁が揃う
  （DBCS の継続空文字列セルは advance に寄与せず、全角が 2 桁を占める）。FF＝新ページ。

## 影響範囲 / 設計方針
- PDF 生成は **server**（`packages/server/src/pdf.ts`）に置く（FS/フォント/pdfkit はサーバー資産）。
  core（`LogicalPage`）に依存。web-ui/MCP から呼ぶ。
- **セキュリティ**: 出力先ディレクトリ・プリンター名は**プロファイル（信頼設定）から**だけ取得し、
  ブラウザの WsOpen 直指定では受けない（任意パス書込・任意コマンド実行の防止）。
- 自動蓄積/印刷は「report 受信時」にサーバーが実行。DL は HTTP エンドポイント＋MCP ツールでオンデマンド生成。

## spec への申し送り
- `renderSpoolPdf(pages, opts)` を pdfkit で実装（フォント・ページサイズ・余白・フォントサイズを opts 化）。
- profile schema に `printer?: { autoPdfDir?, autoPrint?, pdfFont?, pageSize? }` を追加。resolve は server 側のみ。
- lp 呼び出しは失敗/不在に強く（warn して継続）。
- MCP は PDF を base64 で返す（＋保存パス）。web-ui は `/api/spool/:sessionId/:spoolId/pdf` を fetch → ダウンロード。
