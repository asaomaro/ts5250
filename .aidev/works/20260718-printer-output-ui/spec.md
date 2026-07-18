# 仕様: PDF 自動蓄積・自動印刷の UI 設定

## 概要
プロファイル編集（認証オフ or admin かつファイル由来＝canEditProfiles）に、printer 出力設定
（autoPdfDir / autoPrint / pdfFontPath / pdfFontName / pageSize / fontSize）の編集を追加する。
受理は canEditProfiles を満たすルートのみ、露出は編集者のみ。信頼境界は「trusted なユーザーだけが書ける」で維持。

## 設計方針
- `profileInputSchema` に `printer`（既存 `printerSchema`）を optional で受理する。**この入力は
  `ProfileStore.add/update` 経由でしか使われず、両者は canEditProfiles ゲート下の `/api/profiles` からのみ
  呼ばれる**ため、trusted な書き込みに限定される（strict 除外に代わる境界＝ルートゲート）。
- printer は編集者にのみ露出する（`listPublic({ includeSignon })` と同じ editor 限定フラグに相乗り）。
- UI は「プロファイル編集フォーム」にのみ printer 欄を出す（ユーザー接続には出さない）。

## 対象範囲
### 変更（server）
- `profiles.ts`:
  - `PublicProfile` に `printer?: PrinterConfigView`（editor 限定露出用）を追加。
  - `profileInputSchema` に `printer: printerSchema.optional()` を追加。
  - `buildProfile`: `input.printer` を反映（未指定=既存保持 / 空=クリア / 値あり=置換）。`buildPrinter()` ヘルパで
    空文字・空オブジェクトを正規化（意味のあるキーが無ければ undefined）。
  - `listPublic({ includeSignon })`: editor 時に `printer` も含める（コメントを「editor 限定フィールド」に更新）。
- `app.ts`: 変更なし（GET は既に `includeSignon: editable`、PUT/POST は canEditProfiles ゲート済み）。
### 変更（web-ui）
- `ConnectView.vue`:
  - `ConnForm` に printer 出力の平文フィールド（`autoPdfDir?`, `autoPrint?`, `pdfFontPath?`, `pdfFontName?`,
    `pageSize?`, `fontSize?`）を追加。
  - プロファイル編集フォームに「PDF 自動蓄積 / 自動印刷（サーバー設定）」セクションを追加（`isProfileForm` のみ）。
  - `editProfile`: `p.printer` からプレフィル。
  - `saveProfileForm`: これらを `printer` オブジェクトに組み立てて payload に載せる（全空なら printer を送らず＝クリア）。
- 注意書き（Q2）: 「サーバーのローカルパス・サーバー上のプリンター名を指定」する旨を明記。
- **（ついで対応）セッション種別ラベルの明確化**: display 種別の表示を「表示」→**「5250端末」**に変更し、
  プリンター同様に分かりやすい種別チップにする（アプリ自体がエミュレーターのため「エミュレーター」は紛らわしく、
  「プリンター」と対になる「5250端末」を採用）。対象は種別ラベルが出る箇所すべて（カード/一覧の `.kind` チップ、
  カード ⓘ の `infoRows` の「種別」、タブ `SessionInfo` の「種別」、フォームの種別セレクタ option）。
  チップは display/printer とも視認しやすい配色にする（printer=緑、5250端末=識別できる別トーン）。

## インターフェース / データ構造
```ts
// PublicProfile（editor のみ printer を含む）
interface PrinterConfigView {
  autoPdfDir?: string; autoPrint?: string;
  pdfFontPath?: string; pdfFontName?: string; pageSize?: string; fontSize?: number;
}
interface PublicProfile { /* 既存 */ printer?: PrinterConfigView; }

// profileInputSchema（追加）
printer: printerSchema.optional()   // = { autoPdfDir?, autoPrint?, pdfFontPath?, pdfFontName?, pageSize?, fontSize? }

// buildProfile の printer 反映規則
//  input.printer === undefined      → keep.printer を保持
//  input.printer あり・全キー空/無し → printer を外す（クリア）
//  input.printer あり・値あり        → その値で置換（空文字キーは除去）
```

## 振る舞いの詳細
- **受理条件**: `/api/profiles` の POST/PUT は `canEditProfiles`（認証オフ or admin かつ persistable）でのみ通る。
  printer フィールドを含んでいても、非編集者は 403（従来どおり）。認証オンの一般ユーザーは printer を保存できない。
- **露出**: GET `/api/profiles` は editable のときだけ各プロファイルの `printer` を返す。一般公開の一覧では
  printer を返さない（autoPdfDir 等のサーバーパスを一般ユーザーに見せない）。
- **クリア**: 編集フォームで autoPdfDir/autoPrint 等を全て空にして保存すると、`printer` ブロックが消え、
  自動蓄積/印刷は無効化される（＝従来の「未設定」と同じ）。
- **有効化**: 保存後にそのプロファイルでプリンターセッションを開くと、`resolvePrinterOutput` が既存どおり
  受信ごとの PDF 保存・`lp` 印刷を行う（サーバー側の既存機能をそのまま利用）。

## ドメイン固有の考慮 / セキュリティ
- **信頼境界**: printer 出力設定を書けるのは canEditProfiles（trusted）のみ。認証オンの一般ユーザー・未認証は不可。
  `autoPrint` は `spawn("lp", ["-d", name, file])`（シェル非経由）でコマンド注入不可。`autoPdfDir` は生成ファイル名
  固定パターンでの書き込み（任意ファイル上書きではない）。これらは trusted ユーザーの明示設定に限る。
- printer 設定は一般公開の一覧に出さない（editor 限定露出）。

## エラー処理 / 異常系
- 受信時に autoPdfDir 書込不可・lp 不在などは**既存どおり warn で degrade**（UI 設定でも同じ）。事前実在検証はしない。
- fontSize は正数（既存 printerSchema の制約）。不正入力は zod で 400。

## 受け入れ基準との対応
- editor が UI から printer を設定・保存でき profiles.json に反映 → profileInputSchema.printer＋buildProfile。
- 一般/未認証は不可 → ルートゲート（canEditProfiles）。
- editor のみ露出 → listPublic({ includeSignon }) に printer 相乗り。
- 空でクリア → buildPrinter 正規化。
- 受信で PDF/印刷 → 既存 resolvePrinterOutput。

## design への申し送り（複雑度自己評価）
- 既存の profile 編集経路への追加で、複雑なデータモデル/アーキ判断は無い。**design は不要**、plan で分解する。
- テスト: server（printer 受理は editor のみ・一般は 403・露出は editor のみ・クリア）と web-ui ビルドを追加/維持。
