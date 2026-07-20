# テスト結果

## 自動テスト

```
tsc -b                          通過
eslint .                        クリーン
npm run build -w @as400web/web-ui  通過（vue-tsc 込み。テンプレート型チェックあり）
vitest server                   28 files / 266 tests（新規 13）
vitest web-ui                   36 files / 389 tests（新規 22 → 修正後 23）
```

新規テストが固定した不変条件:

- **`maxRows` の上限 1000 がサーバー側で強制される**（1001・0・負値・小数を拒否）。
  クライアントの改竄で超えられないことが要点
- 接続先未指定・`sql` 空・strict 違反・system/session の食い違いを拒否
- 資格情報が無ければ理由の分かる `CONFIG_ERROR`
- **DELETE 文を文面で弾いていない**こと（弾いていると誤解されると D1 の根拠を取り違えるため、
  あえて回帰として固定した）
- CSV: CRLF・RFC 4180 エスケープ・列順は `columns` に従う・0 行でもヘッダーを出す・
  **UTF-8 BOM の 3 バイト**・DBCS 素通し・ファイル名のゼロ埋め
- ペイン: 送信ボディ・NULL 表示・0 行表示・SQLCODE 併記・打ち切り警告・
  CSV の Blob URL 生成と `revokeObjectURL`

## 実ブラウザ確認（Playwright / Chromium・PUB400 実接続）

**自動テストでは拾えないものを見た。**

| # | 確認項目 | 結果 |
|---|---|---|
| 1 | ランチャーに SQL カードが出る | ✅ |
| 2 | ペインが開き textarea が出る | ✅ |
| 3 | **5250 用トグル（カナ）が出ない** | ✅ 出ていない（`App.vue` の配線が効いている） |
| 4 | 実機で SELECT を実行 | ✅ 5 行・列 `TABLE_NAME` / `TABLE_SCHEMA` |
| 5 | CSV ダウンロード | ✅ `query-20260720-020349.csv` |
| 6 | **CSV の先頭 3 バイト** | ✅ `ef bb bf`（BOM あり） |
| 7 | CSV の改行 | ✅ CRLF を含む。本文 `TABLE_NAME,TABLE_SCHEMA` / `AMYRA,AARTI1` |
| 8 | ダークテーマ追従 | ✅ スクリーンショットで確認（配色が CSS 変数に追従） |
| 9 | SQL エラー表示 | ✅ `prepare failed: SQLCODE=-204 SQLSTATE=42704` |
| 10 | **タブを閉じる（切断処理へ流れない）** | ✅ 残りタブ 0・エラーなし（`PaneTabs.isPane` が効いている） |

### 実ブラウザで見つかった欠陥（修正済み）

**エラー文言が二重に出ていた。** core のメッセージが既に
`prepare failed: SQLCODE=-204 SQLSTATE=42704` の形を含むのに、UI が `sqlDetail` を
括弧書きで併記していたため `… （SQLCODE=-204 SQLSTATE=42704）` になっていた。

単体テストは「SQLCODE が表示される」ことしか見ておらず**二重かどうかを見ていなかった**ため、
実ブラウザで初めて分かった。メッセージが既に `SQLCODE` を含むなら併記しないよう直し、
その場合の回帰テストを追加した。

## 未検証の範囲（引き継ぎ）

- **実際の Excel で CSV を開いての確認**。この環境に Excel が無いため、
  BOM と CRLF を**バイト列として確認したに留まる**。「Excel で正しく開ける」ことは未確認
- 認証オンの環境での一般ユーザー / admin の出し分け（`config-resolver.test.ts` に委ねている）
- `truncated` が実際に立つ規模（1000 行超）でのブラウザ表示の重さ
- DBCS を含む実データでの CSV。テストは `名前,日本語` の合成データのみで、
  **PUB400 の実表に DBCS 列を見つけられなかった**
