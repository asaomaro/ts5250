# レビュー記録

## ラウンド 1（2026-07-29）

差分を requirement / spec / AGENTS.md の観点で点検した。**must 0 件・should 0 件・nit 2 件。**
nit はいずれもこのラウンド内で修正済み、または意図的な判断として `decisions.md` に記録した。

### 観点別の確認

**要件との対応**

- ADJUST（`right-zero` / `right-blank` / `mandatory-fill`）・Field Exit・Erase EOF・Erase Input・
  `BindingTarget` 拡張・README 整合の 6 点すべてを実装した（tasks.md 全項目チェック済み）
- 「やらないこと」に挙げた Field− / Field+・FER / AUTO_ENTER / MONOCASE / MANDATORY_ENTER の**強制**・
  DUP キー・`mandatory-fill` の検証には**手を付けていない**（scope の逸脱なし）。
  FFW からは読めるようになったが挙動は変えていない

**原典・実測との整合（AGENTS.md「既存プロトコル実装の移植」）**

- `rightAdjust` は GNU tn5250 `tn5250_display_shift_right` の手順そのまま（先頭 fill → 末尾が非空白に
  なるまで右シフト）。原典の「全空白なら無限ループするので早期 return」も移した
- 参照実装が**実装していない**こと（Erase Input はどちらにも無い / `K_ERASE` は定義だけで未参照）を
  research.md に事実として記録し、backlog の定義を採る根拠にした
- 期待値は実機の実測に基づく。テストのコメントから research.md を辿れるようにした

**規約（AGENTS.md）**

- コメントは why 中心。判断の出所（原典のファイル:行 / 実測）を明記した
- core のピュアロジック層に `node:*` を持ち込んでいない。ライブラリ側でログを直接吐いていない
- 利用者に見える文言は日本語・です／ます調。ローカル編集キーの表示名は
  `KeybindingsPanel.vue` の `LOCAL_EDIT_LABEL` に 1 か所へ集約した
- **秘密の混入なし**（変更ファイル全体を `USER1234` / `password:"…"` / ホスト IP で走査。0 件）。
  新規スクリプトは既存の `SecretCrypto.fromEnv()` 経由で復号する方式に揃えた

**テスト**

- 追加したのは純ロジック（`field-adjust.test.ts` 18 件）・core スナップショット（8 件）・
  検証の緩和（3 件）・キーバインド（5 件）。回帰資産になっている
- 実機 E2E（15 項目）は**ホストが受け取った値まで**確かめている。画面だけの確認で終えていない

### 指摘

- **[nit] 修飾キー付き Backspace / Delete が二重に効く**（`ScreenGrid.vue`）
  → 実装中に発見。SBCS 欄・DBCS 欄の両方へ修飾キーガードを追加して**修正済み**。
  本 work のキーに限らず、利用者が任意の修飾キー付きバインドを作ったときにも効く改善
  （`decisions.md` D9）
- **[nit] Field Exit が値を変えないとき MDT を立てない**（原典は無条件に立てる）
  → **意図的な逸脱として許容**。この PJ には「カーソル移動だけで MDT にしない」という先行決定があり、
  無条件 MDT は SEU の埋め込み色属性が失われる既知の実害を復活させる（`decisions.md` D10）

### 既存の失敗（本作業と無関係・記録のみ）

- `packages/server` の `zip-writer.test.ts` 4 件失敗 — 外部 `unzip` 未インストール。
  変更前（`git stash` 状態）でも同じく失敗することを確認済み
- `npm run lint` 6 件 — すべて**未追跡の既存スクリプト**の未使用変数。本 work の追加分は 0 件。
  コミット対象にも含めない
