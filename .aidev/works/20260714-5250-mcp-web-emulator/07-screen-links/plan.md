# 計画: 07-screen-links — 画面テキストのリンク化（Web のみ）

親: 20260714-5250-mcp-web-emulator（親 decisions D2 で追加。分解のみ・再分割なし）
依存: 03-web（review 承認済み）

## 実装方針

- Web の `ScreenGrid` の **text セグメント**内で、メールアドレス→`mailto:`、URL（http/https）→`<a>` リンクとして
  描画する。5250 画面は固定グリッドで折返しが無いため、**1 行内の連続テキストラン**を対象に検出する
  （複数行にまたがる URL は対象外＝サブセット）。
- 検出は純関数のユーティリティ（`linkify.ts`）に切り出す: 入力文字列 → `{ start, end, href, kind }[]` の範囲配列。
  正規表現で http(s):// と メール（`user@host.tld`）を検出。**href は http/https/mailto のみ許可**（`javascript:` 等は生成しない）。
- 描画は text セグメントを「プレーン部分」と「リンク部分」に分割し、リンクは `<a target="_blank"
  rel="noopener noreferrer">` で出す。**1 文字=1ch を維持**（インラインなので桁ズレしない）。
- input/dbcs/attr セグメントや SO/SI マーク・カタカナ表示中のランはリンク化しない（誤検出・桁崩れ防止）。
- 既定 ON。ワークスペースにトグル（`linkify`）を設けて OFF 可能にする（他の表示トグルと同様）。

## 検証方針（コンポーネント中心）

- ユニット: `linkify()` の検出（URL・メール・複数・境界・非対象文字列・危険スキーム無視）。
- コンポーネント: text 内 URL/メールが `<a href>` として描画される・input/dbcs はリンク化されない・
  桁位置が保たれる・トグル OFF で無効。
- コピペ/Playwright 影響: リンクは `white-space: pre` グリッド内のインライン `<a>`。テキスト選択・
  コピーを妨げないこと（クリック時のみ遷移）をコンポーネントテストで担保。

## リスク / 留意点

- **誤検出**: 画面の記号列を URL 誤認しないよう保守的な正規表現にする。境界（前後が英数字でない）を要求。
- **桁ズレ**: リンクはインライン span/a のみで幅を変えない（下線・色はホスト属性を継承）。
- **セキュリティ**: 生成 href をスキーム allowlist（http/https/mailto）に限定。`rel="noopener noreferrer"`。

## テスト方針（protocol 2.8・この subtask の範囲）

- ユニット（linkify）＋コンポーネント（ScreenGrid のリンク描画・非対象・トグル）。
- 受け入れ基準の総点検は親統合 test に委ねる。実機依存なし（純クライアント表示機能）。
