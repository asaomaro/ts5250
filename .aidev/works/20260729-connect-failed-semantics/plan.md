# 計画: `CONNECT_FAILED` の意味を取り戻す

## 実装方針

**型 → 投げる側 → 写像 → 判定 → 検証**の順。型（`errors.ts`）を先に足さないと
server 側がコンパイルできない。

subtask には割らない。12 箇所の付け替えと 1 コード追加で、**分けると受け入れ基準
（「接続以外の `CONNECT_FAILED` が残っていない」）を単独で検証できない**。

## 作業順序と依存関係

1. `errors.ts` に `SESSION_LIMIT` を追加し、**全コードに用途の JSDoc**（依存: なし）
2. `host-api.ts` の `statusOf` に `SESSION_LIMIT` → 409（依存: 1）
3. server の 12 箇所を付け替え（依存: 1）
4. `ws-handler.ts` の `fatal` を状態判定へ（依存: 3）
5. テスト（依存: 2,3,4）
6. 文書（backlog・decisions）（依存: 5）

## リスク / 留意点

- **写像の足し忘れは 502 に落ちる**（既定が 502）。`statusOf` のテストで固定する
- **`grep` で「残っていない」を守る**。付け替えは機械的なので漏れが起きやすい。
  受け入れ基準そのものをテストにする（server の src を読んで接続以外の
  `CONNECT_FAILED` が無いことを確かめる）——ただし**行の意味は機械には分からない**ので、
  「server に `CONNECT_FAILED` を投げる箇所が 0 件」という強い形にする
  （core が投げる分は残るので、server だけを見る）
- **`fatal` の分類が 1 ケース変わる**（`open` 前の `key`）。読んでいる側は無いが、テストで固定する
- メッセージ本文は変えない。変えると利用者の見る文言まで動く

## テスト方針

### server（`packages/server/test/`）

- **写像**: `statusOf` が `SESSION_LIMIT` → 409、`CONFIG_ERROR` → 400、`CONNECT_FAILED` → 400、
  未知は 502（既存の写像表テストの形式に倣う）
- **上限**: 表示・プリンターの両方が `SESSION_LIMIT` を投げる（既存テストの書き換え＋プリンター分の追加）
- **設定系**: 読み込み失敗・スキーマ違反・平文パスワード・`passwordEnv` 未設定・指定不足が
  `CONFIG_ERROR` になる
- **不変条件**: `packages/server/src/**` に `new As400Error("CONNECT_FAILED"` が**1 件も無い**
  （接続は core の仕事。server から投げる筋は無い）
- **`fatal`**: `open` 失敗（指定不足）で true / セッション中の欄エラーで false /
  `SESSION_CLOSED` で true

### 空振り検証（mutation）

- `statusOf` の `SESSION_LIMIT` を消す（→ 502 に落ちる）
- 上限を `CONNECT_FAILED` に戻す（表示・プリンターそれぞれ）
- 設定系を 1 箇所ずつ `CONNECT_FAILED` に戻す
- `fatal` をコードの列挙に戻す
