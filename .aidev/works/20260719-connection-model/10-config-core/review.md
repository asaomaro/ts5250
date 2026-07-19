# レビュー: 10-config-core

## ラウンド 1（自己レビュー）

差分: `config-types.ts` / `config-migrate.ts` / `config-store.ts` / `config-resolver.ts` の新設、
旧 2 ストアへの `@deprecated`、テスト 3 本（72 ケース）。

### must

**M1: `owner` を入力から採れてしまう**（`config-store.ts` `addSystem` / `addSession` / `updateSession`）

`systemSchema` / `personalSessionSchema` は `owner` を持つため、リクエスト本文で `owner` を指定できた。
`user` が定義されていれば直後に上書きされるが、**認証オフ（`user` が undefined）では入力値がそのまま残る**。
認証オフは localhost 束縛の単一信頼ユーザーなので実害は無いが、所有者は
「リクエストの文脈から決めるもの」であって本文で指定させる筋合いがない。

→ **修正**: `stripOwner()` で入力から `owner` を落としてから parse する。
`.omit({owner:true})` で**弾く**案も試したが、`listSystems` の応答が `owner` を含むため、
UI がそれを編集して送り返すと 400 になる。**弾かずに無視**する形にした。

**M2: 移行の親システム解決に無効なフォールバックがあった**（`config-migrate.ts`）

`systemOf.get(name) ?? systems[0]?.id ?? p.host` と書いており、束ねの実装バグがあったときに
**存在しないシステム id を静かに埋め込む**（`p.host` はシステム id ではない）。
その場合エラーは `assertIntegrity` の「references missing system」として遅れて出るため、
原因の見当がつかない。

→ **修正**: `requireSystem()` を追加し、見つからなければ移行時点で明示的に落とす。

### should

**S1: 警告メッセージに内部 id が出ていた**（`config-migrate.ts`）

個人設定の移行では束ねキーに `c.id` を使うため、規則 3 の警告が
`c-8f3a...: 資格情報を持たない設定ですが…` と表示され、利用者にどの設定か伝わらない。

→ **修正**: `Item` に `label` を追加し、警告には人間向けの名前を使う。

### nit

なし。

### 確認したが問題なしと判断した点

- `updateSystem` のパスワード保持（空送信で既存を維持）は既存挙動の踏襲。テスト済み
- `removeSystem` が子セッションの残存を拒否するのは、参照の整合性を壊さないため意図的
- `ConfigResolver` が session と system の両方で `assertAccess` を呼ぶのは冗長に見えるが、
  細工されたファイルで所有者が食い違う場合に備えた二重確認なので残す

## 結果

must 2 件・should 1 件をこのラウンドで修正。再実行で lint・build・全テスト緑（サーバー 274 / 全体 1,029）。
差し戻しは行わない（指摘者と修正者が同一で、修正が同一ラウンド内に収まったため）。

## 次工程への申し送り

- `20-server-surfaces` で旧 2 ストア（`profiles.ts` / `connection-store.ts`）を削除する。
  この slice では `@deprecated` を付けるに留めている（消すとビルド不能になるため）
- 実機（PUB400）確認はこの slice の範囲外。`20` と親の統合 test で行う
- 信頼境界 5 層のうち、**1 層目（個人設定に printer を持たせない）と 5 層目（サーバー由来のみ供給）**は
  この slice でテスト済み。2〜4 層目（ルートゲート・display 破棄・保存前検証）は `20` の担当
