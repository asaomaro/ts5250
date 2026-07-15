# 振り返り: AS400 5250 MCP サーバー ＋ Web エミュレーター

## サマリ

7 subtask（01–07）を 1 PR に集約して 5250 MCP サーバー＋Web エミュレーターをデリバリ（受け入れ基準 13 項目
＋GUI/リンクを自動 239 テスト＋実機 PUB400 E2E で検証、walkthrough 経由で deliver）。**その後、ユーザーの
実機利用に基づく多数の不具合修正・機能追加を反復**（本セッションの作業量の大半はこの deliver 後フェーズ）。
最終的にデスクトップ配布（Electron）・接続管理・操作性改善まで到達し、リポジトリ公開・README 拡充で締めた。

deliver までの正規ワークフローは metrics に記録されているが、**deliver 後の反復は工程外のため定量指標が無い**
（本 retro の主要な学びの一つ）。

## うまくいった点

- **trace-first ＋リプレイ回帰**: 実機トレースを fixture 化し、パーサ・画面モデルをオフラインで安定開発。
  PUB400 の接続制限・週次再起動を回避できた。
- **共通コア（ScreenSnapshot）**: MCP と Web が同一の画面表現を消費するため、表示・振る舞いが定義上一致。
  片方の修正が両方に効く設計が終盤の改修でも効いた。
- **実機診断スクリプトで事実に基づく切り分け**: `diag-signon.mjs` / `diag-pdm.mjs` で「送出バイトは
  byte-perfect」「コマンド欄は len=153 の複数行フィールド」「属性下線がフィールドを越えて漏れている」等を
  客観的に確認でき、憶測でなくデータで原因特定できた。
- **各修正でユニットテストを追加**（220→269）。回帰資産化され、後続の修正で他機能を壊さずに済んだ。
- **design 工程の grilling（複数 send-back）** が SPA/フレームワーク選定・v-model 方針・入力制限等の仕様を
  早期に固め、コア設計の作り直しを防いだ。

## 課題 / 手戻り

1. **deliver 後の反復が大量に発生**（本来 spec/test で拾いたかった実機操作系）: タブ/矢印移動がスタブのまま、
   複数行フィールドの回り込み、属性下線の非編集エリア漏れ、パスワード表示、欄内カーソル配置——いずれも
   実機で初めて露呈。**Playwright E2E はあったが「人が触る操作感」の観点が test 方針に不足**していた。
2. **カーソル／編集モデルの同期に繰り返し苦戦**: フォーカス移動（EmulatorPane）と編集モデル（ScreenGrid の
   `edit.cursor`）が別コンポーネントに分かれ、native caret と `edit.cursor` の不一致を何度も生んだ
   （スペース埋め導入で顕在化、`focusCursorField` の already-focused ケース、keydown での resync）。
   **設計上の責務分割が根本原因**で、同じクラスのバグを複数回踏んだ。
3. **ビルドで vue-tsc を回していなかった**: `vite build` はテンプレート型チェックをしないため、
   `GuiSelectionLike` の row/col 欠落等のテンプレート型エラーが deliver 後まで潜伏。
4. **Vue の Boolean prop 既定 false の罠**（linkify が常に無効化）で 1 往復。
5. **vitest をリポジトリルートから実行して vue plugin が適用されず**、一時「コンポーネントが壊れた」と誤判断
   しかけた（正しくはパッケージ dir から実行）。原因特定に時間を要した。
6. **秘密情報の混入**: `01-core-sbcs/decisions.md` に実パスワードを平文記載 → **公開直前まで気づかず**。
   deliver ゲートに secret scan が無かった。履歴書き換え（filter-branch）＋force-push＋squash で対処したが、
   マージ済み PR の orphan コミットは GitHub が `refs/pull/1/head` として保持し、`delete_repo` 権限が無いため
   完全除去できず（パスワード変更で無害化して収束）。
7. **PUB400 手動 field-signon の CPF1120 が未解決**: 送出バイトは byte-perfect（tn5250 準拠）と確認できたが、
   ACS では通るとの報告があり原因未特定（ネゴシエーション差か、ACS 側が実は auto-signon か、の切り分け待ち）。

## 改善提案

### 製品 / コード（→ issue 候補）

- 複数行フィールドの行またぎ編集（現状は 1 行目＝可視桁のみ）。コマンド行の 2 行目対応。
- 画面全体の自由カーソル（非入力エリアを含む任意位置）＝5250 らしい単一カーソルモデルへの作り替え。
- **カーソル／編集モデルの一元化**: 編集状態を ScreenGrid に集約し、native caret を単一の真実として扱う設計へ。
  課題 2 の再発防止。
- 手動 field-signon の未解決調査（ACS の実トラフィックを packet capture して差分特定）。
- PR #1 の orphan コミット完全パージ（`delete_repo` 付与でリポジトリ作り直し。任意）。

### PJ プロセス / 規約（→ AGENTS.md）

- **ビルドに vue-tsc を必須化**（`vite build` 前に `vue-tsc -b`）→ テンプレート型エラーの早期検出（課題 3）。
- **`.aidev` 成果物に実資格情報を書かない**規約＋**secret scan**（パスワード/トークン検出）を
  `aidev verify` か pre-commit に追加（課題 6）。
- **web-ui テストはパッケージ dir から実行**（vue plugin 適用）を手順として明記（課題 5）。
- **test 方針に「人が触る操作感」の実機観点を追加**: Tab/矢印/ホイール/複数行フィールド/属性下線/パスワード欄
  （課題 1）。

### ハーネス自体（→ aidev-* への提案・適用は人間）

- **deliver 後の反復（maintenance）を扱う工程／ループが無い**: 本セッションの大半が deliver 後で metrics に
  載らず、リードタイム・手戻り・件数が定量化できない。post-deliver の event 記録機構、または作業の再オープン
  （`reopen`）を検討（課題 1 の可視化）。
- **deliver／公開前の secret-scan ゲートを protocol に追加**: 今回の混入は手動公開時まで未検出だった。
  deliver 工程 or `aidev verify` に秘密検出を組み込む（課題 6）。
- retro が単一 works 前提で、deliver 後の膨大な反復（別 issue 化すべき粒度）を構造的に拾えない。
  「deliver 後の追補は followup issue に分割」を促すガイドがあるとよい。
