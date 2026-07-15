# レビュー: 07-screen-links

## ラウンド 1（2026-07-15）

対象: 画面テキストのリンク化（T1–T4）の差分。subtask 単独レビュー。

### 点検観点と結果

- **要件適合**: メール→mailto、URL→`<a>` リンク（Web のみ）を満たす。既定 ON＋トグルで OFF 可。
- **正確性・セキュリティ**:
  - href は `URL_RE`（`https?://` のみ）と `mailto:` のみ生成 → **スキーム allowlist** が正規表現で担保
    （`javascript:`/`ftp:` 等は不生成）。Vue の `:href` 属性エスケープと併せて XSS リスクなし。
  - URL 末尾句読点除去・URL 内メールの二重検出防止・TLD 無し除外を確認。`splitLinks` の分割整合も unit で確認。
  - リンクは text ラン限定（input/dbcs/attr は対象外）、カタカナ表示中は無効（`linkEnabled`）、`@click.stop`
    でカーソル移動を抑止しつつ既定のナビゲーションは維持、`rel="noopener noreferrer"` `target="_blank"`。
  - `withDefaults` で linkify 既定 true（Vue の未指定 Boolean prop→false キャスト対策）。
- **規約適合**: console/TODO 残置なし。lint clean。周辺の表示トグル（showShiftMarks/katakanaView）と一貫。

### 指摘

- must: なし
- **should S1（要修正）**: `ScreenGrid` の行描画 `v-memo="[segs]"` が `linkEnabled` を含まないため、
  **🔗 トグルを切替えても既存行が再描画されず、リンク表示が即時に切り替わらない**（次の画面更新まで反映されない）。
  `showShiftMarks`/`katakanaView` は `rows` computed（`displayChar`）経由で segs が変わるため再描画されるが、
  `linkParts` はテンプレート評価で `linkEnabled` に依存するため memo キーに含める必要がある。
  → coding へ差し戻し。`v-memo="[segs, linkEnabled]"` に修正し、トグル再描画のコンポーネントテストを追加する。
- nit: なし

### 判定

should 1 件 → coding へ差し戻し（sent_back）。修正・再 test 後に再レビューする。

## ラウンド 2（2026-07-15）

- S1 対応: `v-memo="[segs, linkEnabled]"` に修正。linkify トグル true→false で `<a>` が消えることを
  コンポーネントテストで検証（回帰資産化）。全テスト green・lint clean。
- must/should なし → subtask review 通過。カーソルは全 subtask 完了として親へ戻る（次: 親の統合 test）。
