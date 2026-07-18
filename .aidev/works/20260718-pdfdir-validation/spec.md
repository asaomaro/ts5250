# 仕様: PDF 出力先を保存時に検証する

## 概要
サーバー設定の保存経路でのみ `printer.autoPdfDir` を検証する。存在・種別・書き込み可否を確認し、
失敗は 400 と原因つきメッセージで返す。**ディレクトリは作成しない**。

## 設計方針

### 方針 1: 検証は独立モジュール（`output-dir.ts`）に置く
`profiles.ts` はスキーマと永続化の責務。ファイルシステム検査を混ぜない。
`app.ts` の保存ルートから呼ぶ純関数にし、単体テストしやすくする。

```ts
export interface DirCheck { ok: true; path: string } | { ok: false; reason: string }
export async function checkOutputDir(dir: string): Promise<DirCheck>
```

### 方針 2: 書き込み確認は「実際に書いて消す」
`access(W_OK)` は環境によって実態と乖離する（読み取り専用 FS・ACL 等）。
一意な一時ファイル名で `writeFile` → `unlink` を行い、**finally で必ず削除**する。

一時ファイル名は `.as400-write-test-<pid>-<連番>` とし、衝突と残骸を避ける。

### 方針 3: `resolve()` した絶対パスを返す
相対パスはサーバーの cwd 基準で解決されるため、**解決結果を応答に含めて UI に出す**。
タイポ（`/hom/...`）や相対パスの誤解に気づける。保存する値は入力のまま（正規化しない）。
※正規化するとプロファイル間で表記が変わり差分が出るため、表示のみに使う。

### 方針 4: 検証するのは保存経路だけ
`POST /api/profiles` / `PUT /api/profiles/:name` のみ。
**起動時（`ProfileStore.fromFile`）と接続時には検証しない** — 出力先が一時的に見えないだけで
起動不能になったり既存設定が壊れるのを避ける（requirement の明示要件）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/server/src/output-dir.ts` | **新規**。`checkOutputDir` |
| `packages/server/src/app.ts` | 保存 2 ルートで検証、400 応答、`resolvedPdfDir` を返す |
| `packages/web-ui/src/components/ConnectView.vue` | 保存失敗をフォームにインライン表示 |
| `packages/server/test/output-dir.test.ts` | **新規** |
| `README.md` | 出力先は事前に作成が必要・保存時に検証される旨 |

**触らない**: `printer-output.ts`（受信時の警告・ステータスは現状維持）、`profiles.ts` のスキーマ、
`canEditProfiles`、`connectionInputSchema`。

## インターフェース / データ構造

**成功時**（201 / 200）— 既存応答に追加。`autoPdfDir` 未指定なら含めない。
```json
{ "profile": { ... }, "resolvedPdfDir": "/var/spool/as400-pdf" }
```

**失敗時**（400）
```json
{ "error": "PDF 出力先が見つかりません: /var/spool/as400-pdf（先にフォルダを作成してください）" }
```

理由は 3 種を区別する。
| 状態 | メッセージ |
|---|---|
| 存在しない | `PDF 出力先が見つかりません: <path>（先にフォルダを作成してください）` |
| ディレクトリでない | `PDF 出力先がフォルダではありません: <path>` |
| 書き込めない | `PDF 出力先に書き込めません: <path>（<原因>）` |

## 振る舞いの詳細

- `autoPdfDir` 未指定 / 空文字 → 検証しない（従来どおり保存）。
- 検証は**保存の前**に行う。失敗時は `profiles.save()` を呼ばない（不正な設定を永続化しない）。
- 検証成功後の保存が失敗した場合は従来どおりのエラー経路。
- 一時ファイルは成功・失敗いずれでも削除する（`finally`）。

## エラー処理 / 異常系

- `stat` が `ENOENT` 以外で失敗（権限で辿れない等）→ 「書き込めません」に集約し原因文字列を添える。
- 検証中の予期しない例外は 400 として理由を返す（500 にしない。入力起因のため）。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 存在しない → 400・作成されない | `checkOutputDir` は `mkdir` を呼ばない。テストで未作成を確認 |
| ファイル指定 → 400 | `stat().isDirectory()` |
| 書き込めない → 400 | 実書き込みテスト（`chmod 0o500` で検証） |
| 成功時に絶対パス | `resolve()` の結果を `resolvedPdfDir` で返す |
| 未指定は成功 | 早期 return |
| 一時ファイルが残らない | テストで検証後のディレクトリ内容を確認 |
| 起動時に検証しない | `fromFile` に手を入れない。既存テストで担保 |
| UI にインライン表示 | 既存の `error` 表示経路に載せる |
