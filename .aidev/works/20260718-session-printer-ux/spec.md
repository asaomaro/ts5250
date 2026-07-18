# 仕様: 接続・セッション情報表示とプリンター UX 改善

## 概要
接続カード/一覧とタブのセッション情報を拡充し、プリンターペインの視認性と運用性を上げる。
プリンターの MSGW（CPA3394）は運用誘導＋UI 案内で解消（クライアント自動応答は不可＝research F1）。
すべて web-ui 中心（新規サーバー API 不要）。

## 設計方針
- 接続メタ（host/port/ccsid/screenSize/deviceName/tls/sessionType/autoSignon/signonUser）を **open 時に
  `SessionState.meta` へ載せる**（`ConnectView` が `PublicConnection`/`PublicProfile` から供給）。資格情報の平文は載せない。
- 情報表示は **バックドロップ付きポップオーバー**で統一（カード ⓘ・タブ ⓘ とも外側クリックで閉じる）。
- プリンターの未読は `SessionState.unread` で管理し、表示中（PrinterPane マウント時）にクリアする。

## 対象範囲
### 変更
- `packages/web-ui/src/stores/sessions.ts`: `SessionState` に `meta?`（接続メタ）と `unread?` を追加。
  `addReport` で `unread++`、`markSpoolRead(id)` を追加。
- `packages/web-ui/src/session-controller.ts`: `openSession`/`openPrinterSession` に `meta?` 引数を追加し state に保存。
- `packages/web-ui/src/components/ConnectView.vue`:
  - 項目1: カード/一覧にデバイス名表示。
  - 項目2: カードに ⓘ ボタン＋全情報ポップオーバー（バックドロップ/ⓘ で閉じる）。
  - 接続時に接続メタを `openSession`/`openPrinterSession` に渡す。
- `packages/web-ui/src/components/SessionInfo.vue`:
  - 項目3: バックドロップで閉じる。
  - 項目4: 接続メタ（host/port/ccsid/screenSize/deviceName/tls/種別/サインオン）を表示、重複統合。
- `packages/web-ui/src/components/PaneTabs.vue`:
  - 項目3: タブ情報のバックドロップ close を配線。
  - 項目7: プリンタータブに未読バッジ表示、アクティブ化でクリア連携。
- `packages/web-ui/src/components/PrinterPane.vue`:
  - 項目5: 待ち受け中ヒントに CPA3394 回避手順（`STRPRTWTR DEV(<dev>) FORMTYPE(*ALL)`）＋コピー。
  - 項目6: サイドバー開閉トグル＋上部フィルタ入力（title/本文で絞り込み）。
  - 項目7: 表示時に `markSpoolRead` で未読クリア。
- `README.md`: プリンターセッションに FORMTYPE(*ALL) 運用を追記。
### 追加（任意・再利用のため）
- `packages/web-ui/src/components/InfoPopover.vue`（新）: `rows: {label,value}[]` を受けてバックドロップ付きで表示する
  汎用ポップオーバー（カード ⓘ で使用。SessionInfo は既存構造を活かし内部にバックドロップを足す）。

## インターフェース / データ構造
```ts
// SessionState 追加
interface SessionMeta {
  host?: string; port?: number; tls?: boolean; ccsid?: number;
  screenSize?: "24x80" | "27x132"; deviceName?: string;
  sessionType?: "display" | "printer"; autoSignon?: boolean; signonUser?: string;
}
interface SessionState {
  // ...既存...
  meta?: SessionMeta;
  /** 未読スプール数（プリンター。受信で++、表示でクリア） */
  unread?: number;
}

// session-controller
openSession(open: WsOpen, label: string, meta?: SessionMeta): Promise<string>;
openPrinterSession(open: WsOpen, label: string, meta?: SessionMeta): Promise<string>;

// sessions store
addReport(id, report): void; // 既存 + s.unread = (s.unread ?? 0) + 1
markSpoolRead(id: string): void; // s.unread = 0
```

## 振る舞いの詳細
### 情報ポップオーバー（項目2・3・4）
- **カード ⓘ**（`ConnectView`）: クリックで全情報（名称・ホスト・ポート・TLS・CCSID・画面サイズ・デバイス名・
  種別・自動サインオン・サインオンユーザー・共有/保存済みの別）を表示。ⓘ 再クリックまたは**バックドロップ**で閉じる。
- **タブ ⓘ**（`SessionInfo`）: 従来の（ラベル/状態/画面/ジョブ or 起動・受信）に加え、接続メタ（ホスト/ポート/CCSID/
  画面サイズ/デバイス名/TLS/種別/サインオンユーザー）を表示。**重複統合**:
  - CCSID は `state.ccsid`（実効）を 1 行に統一（meta.ccsid は同値のため重複表示しない）。
  - 画面は「実際 = snapshot rows×cols」を主に、設定 `screenSize` が異なる場合のみ併記（例 `24x80（設定 27x132）`）。
  - 種別は 1 行（display/printer）。
  - **バックドロップで閉じる**（項目3）。
- バックドロップ: 画面全体を覆う透明レイヤ（`position: fixed; inset: 0`）。クリックで閉じ、ポップオーバー本体の
  クリックは伝播させない（`@click.stop`）。Esc でも閉じられるとなお良い（任意）。

### プリンター MSGW 案内（項目5）
- 受信ゼロ時の待ち受けヒントに、CPA3394（用紙タイプ問い合わせ）で writer が MSGW 停止する場合の回避を明記:
  「writer を用紙タイプ不問で起動すると毎回の応答が不要: `STRPRTWTR DEV(<デバイス名>) FORMTYPE(*ALL)`
  （既存 writer は `CHGWTR WTR(<デバイス名>) FORMTYPE(*ALL)`）」。デバイス名は `state.meta.deviceName` があれば差し込む。
  コマンドはワンクリックでコピーできるようにする。

### サイドバー開閉・フィルタ（項目6）
- サイドバー（スプール一覧）に**開閉トグル**（折りたたむとビューア全幅）。
- 一覧上部に**フィルタ入力**。`reportTitle` または各ページ本文（`lines`）に**大文字小文字無視の部分一致**でフィルタ。
  一致 0 件時は「該当なし」を表示。選択中スプールがフィルタ外になっても選択は保持（ビューアは表示し続ける）。

### 未読バッジ（項目7）
- `addReport` で `unread++`。`PrinterPane` は表示（マウント＝アクティブタブ）時と、表示中に新規受信したときに
  `markSpoolRead` を呼びクリア（visible なら即クリア→バッジは非アクティブ時のみ出る）。
- `PaneTabs` はプリンタータブに `unread>0` のとき件数バッジ（例 ●3）を出す。タブをアクティブ化して PrinterPane が
  マウントされるとクリアされる（requirement Q3: アクティブ化で解消）。

## エラー処理 / 異常系
- meta が無い（直叩き接続等）場合、情報表示は持っている項目のみ出す（欠損はスキップ）。
- フィルタで全件除外されても selectedReportId は保持し、ビューアは維持。

## 受け入れ基準との対応
- 項目1: カード/一覧の `<small>` にデバイス名を追加。
- 項目2: カード ⓘ ＋ `InfoPopover`（バックドロップ close）。
- 項目3: `SessionInfo` にバックドロップ close。
- 項目4: `SessionInfo` に `state.meta` の接続情報を統合表示。
- 項目5: `PrinterPane` ヒント＋README に FORMTYPE(*ALL)。
- 項目6: `PrinterPane` サイドバー開閉＋フィルタ。
- 項目7: `unread`＋`PaneTabs` バッジ＋`PrinterPane` クリア。

## design への申し送り（複雑度自己評価）
- 追加は主にローカル UI 状態とコンポーネント内実装で、複雑なデータモデル/アーキ判断は無い。**design は不要**、
  plan で作業分解して進める。テストは web-ui（stores/コンポーネント）に追加し、既存 258 テストを維持する。
