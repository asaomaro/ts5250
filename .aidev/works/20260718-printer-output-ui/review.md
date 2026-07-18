# レビュー記録

## ラウンド 1（2026-07-18）

差分（server `profiles.ts`/index、`app-profiles.test`、web-ui `ConnectView`/`SessionInfo`、README）を点検。

### セキュリティ（重点）
- **受理経路の境界**: `profileInputSchema` に `printer` を許可したが、`ProfileStore.add/update` は canEditProfiles
  ゲート下の `/api/profiles`（POST/PUT）からのみ呼ばれる。一般ユーザー・未認証は**ルートで 403**となり printer 入力に
  到達しない（app-profiles テストで「一般 printer 付き PUT=403」を固定）。→ trusted 書き込み限定を維持。
- **露出の限定**: `listPublic({ includeSignon })` の editor 時のみ `printer` を返す。一般ユーザーの GET（editable=false）は
  printer を返さない（テスト固定）。autoPdfDir 等のサーバーパスを一般に見せない。
- **コマンド/パス**: `autoPrint` は既存の `spawn("lp", ["-d", name, file])`（シェル非経由）で注入不可。`autoPdfDir` は
  生成ファイル名固定での書き込み。いずれも trusted ユーザーの明示設定に限る（profiles.json を直接編集できる層と同等）。

### 正確性 / エッジケース
- `buildPrinter(input, keep)`: input 未指定→keep 保持 / 空文字除去後キー無し→undefined（クリア）/ 値あり→置換。
  空クリアと保持をテストで固定。signon の undefined=保持と一貫。
- UI: printer 欄は `isProfileForm` のみ。`saveProfileForm` は常に `printer` を送る（全空なら server 側でクリア）。
  プロファイル新規作成は UI に無い（「＋新規接続」は connection）ため、printer は既存プロファイル編集時のみ扱う。
- ラベル「表示」→「5250端末」を全箇所（カード/一覧チップ・infoRows・SessionInfo・form option）で統一。チップ配色は
  5250端末=青（--t-blue）/ プリンター=緑（--accent）で識別可能。

### 指摘
- [nit] `pdfFontPath`/`pdfFontName` は ConnForm と prefill/save に含むが UI 入力欄は無い（上級設定）。既存値は
  round-trip で保持され、壊さない。/ 対応: 許容（ファイル編集向けの上級項目）。
- [nit] fontSize/pageSize のみ設定すると display プロファイルが printer 種別になる（autoPdfDir/autoPrint 無しでも
  printer ブロックが残る）。resolvePrinterOutput は autoPdfDir/autoPrint 無しなら無出力なので実害なし。/ 対応: 許容。

### 判定
must / should: 0 件。nit: 2 件（いずれも許容）。→ review 通過。
