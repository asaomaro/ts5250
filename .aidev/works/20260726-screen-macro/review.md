# レビュー記録

## ラウンド 1（2026-07-26T23:35Z）

差分: server 5 ファイル変更 ＋ 3 ファイル追加 / web-ui 8 ファイル変更 ＋ 4 ファイル追加 /
テスト 7 ファイル（追加 6・変更 3）。

### 指摘

- **[should]** `packages/web-ui/src/session-controller.ts:305` `selectGuiChoice` が
  `noteUnrecordable()` を呼ばない。`submitGuiSelection` には印を立てているのに非対称。
  記録中に GUI 選択（ラジオ・チェック）を切り替えてから Enter を押すと、**選択の切り替えは
  記録されず Enter だけが記録される**。再生すると選択が反映されないまま Enter が飛ぶ＝
  黙って壊れたマクロができる。spec D8 の「黙って壊れたマクロを作らない」に反する。
  / 対応: 修正済（`selectGuiChoice` にも `noteUnrecordable()` を追加）

- **[should]** `packages/server/src/ws-handler.ts:243` `resolveField` が `secretRef` の
  **形を検証していない**。`"value" in f` が false なら `f.secretRef` をそのまま
  `resolveSecret()` へ渡すため、`{ field: 1 }` だけのメッセージで `ref.macroId` を読んだ時点の
  TypeError が `INTERNAL_ERROR` として JS のエラーメッセージごとクライアントへ返る。
  **秘密を守る経路の信頼境界**であり、`macroSecretRefSchema` は既に定義済みなのに未使用。
  / 対応: 修正済（`macroSecretRefSchema.safeParse` で検証し、不正は `PROTOCOL_ERROR`）

- **[should]** `packages/server/src/macro-store.ts:220` `toPublic()` が `screen`（オブジェクト）を
  **参照のまま返す**。同関数内で `fields` / `cursor` / `promptFields` は複製しているのに
  `screen` だけ共有しており不整合。`config-types.ts` の `publicSession` は同じ理由で
  watermark を明示的に複製し「参照のまま渡すと、応答を受け取った側の書き換えがストアの実体に届く」と
  コメントしている前例がある。HTTP 経路は JSON 化されるので実害は出ないが、
  `buildApp` を直接呼ぶ組み込み・テスト経路では実体に届く。
  / 対応: 修正済（`screen` を複製して返す）

- **[nit]** `packages/web-ui/src/macro-engine.ts` 最終ステップの送信直後に `completed` にするため、
  **最後の応答を待たずに OIA から「▶ 再生中」が消える**。`🔒 応答待ち` が出るので実害は小さい。
  / 対応: 許容（挙動として自然な範囲。直すと「送り終えたのに終わらない」状態が生まれる）

- **[nit]** 書き込み欄を持たないステップ（F キーだけの遷移）は `screen.targets` が空になり、
  実質 **rows/cols しか照合しない**。spec D4 が「打ち込み先の同一性に限定する」と意図的に選んだ
  折り合いの帰結であり仕様どおりだが、純粋な画面遷移だけのマクロは照合が効かない。
  / 対応: 許容（**既知の限界として PR に明記**する。D4 は誤検知回避のため意図的に緩くしてある）

- **[nit]** `packages/server/src/macro-types.ts` の `aidKeySchema` が core の `AidKey` と
  二重定義になっており、core 側に AID キーが増えたとき気付けない。
  / 対応: 修正済（コンパイル時に両者の一致を突き合わせる型アサーションを追加）

### 判定

must 0 / should 3 / nit 3。should は coding へ差し戻して修正。

### 確認できた点（指摘なし）

- **秘密の扱い**（spec D5・D11）: `toPublic` が `secretEnc` を落とすこと、API 応答・
  localStorage・操作ログのいずれにも平文が出ないことをテストで固定できている。
  `resolveSecret` は `assertOwner` を必ず通り、失敗時は**空文字にフォールバックせず throw** する。
- **`WsKey` の拡張が加算的**（spec D11・plan R-b）: 既存形 `{field, value}` をそのまま残した
  union なので、既存の送信経路は型・実行時とも影響を受けない（server 578 テストで確認）。
- **記録フックの非侵襲性**（受け入れ基準 A8）: `idle` 時は `recordSend` が即 return し、
  `sendKey` の送信内容は従来と同一（明示テストあり）。
- **AGENTS.md 整合**: `console.*` 不使用 / core に Node 依存を持ち込んでいない
  （`SecretCrypto` は server に閉じたまま）/ 判断の出所を `spec D1`〜`D11` 形式で参照 /
  俯瞰コメントを `macro-record.ts`・`macro-engine.ts`・`sendKey`・`resolveField` に配置。
- **UI-DESIGN 整合**: `.theme-btn` 相当の固定高 28px・`inline-flex`、ラベルは固定幅 span で
  レイアウトシフト防止、`headerMenu.ts` に参加、`role="status"`、
  `confirm`/`prompt` は既存（IfsPane・AdminPane・ConfigCard）と同じ流儀。

## ラウンド 2（2026-07-26T23:40Z）

ラウンド 1 の should 3 件・nit 1 件を修正したうえでの再点検。

### 指摘

指摘なし。

### 修正の確認

- **should（`selectGuiChoice` の非対称）**: `noteUnrecordable()` を追加。
  回帰テスト「選択の切り替えだけでも印を立てる」を追加し、`submitGuiSelection` と対称になった。
- **should（`secretRef` 未検証）**: `macroSecretRefSchema.safeParse` で検証し、不正は
  `PROTOCOL_ERROR`。回帰テストで 4 パターン（空・欠け・型違い・キー自体なし）を確認し、
  **いずれも 1 欄も書かれない**ことを `setField` スパイで固定した。
- **should（`toPublic` の参照共有）**: `screen` と `targets` を複製。
  回帰テスト「返した値を書き換えてもストアの実体に届かない」を追加。
- **nit（AID キーの二重定義）**: 双方向の型パリティアサーションを追加。
  **実際に効くことを確認済み**——`aidKeySchema` から `Attn` を 1 つ外すと
  `TS2322: Type 'true' is not assignable to type 'never'` でビルドが落ちる。

### 検証結果

- server: 44/45 ファイル緑（585 passed）。失敗 4 件は `zip-writer.test.ts` の
  `spawnSync unzip EACCES`＝**環境に `unzip` が無い**ことによる既存の失敗で、本変更と無関係
- web-ui: 79/79 ファイル緑（896 passed）
- ビルド: `tsc -b`（server）/ `vue-tsc -b && vite build`（web-ui）とも成功
- lint: 変更分 0 件（残る 6 件はすべて作業開始前から未追跡の `scripts/*.mjs`）

### 判定

must 0 / should 0 / nit 0。review 通過。

### deliver へ引き継ぐ既知の限界

1. **書き込み欄を持たないステップは照合が rows/cols だけ**になる（spec D4 の意図的な折り合い）。
   F キーだけで遷移するマクロは画面照合が実質効かない。
2. **`unzip` 不在のため zip 相互運用が未検証**（本変更と無関係だが、この環境での実行結果として）。
3. **実機（IBM i）での記録→再生が未実施**。IME・DBCS 欄・パスワード欄での操作感は
   AGENTS.md の test 方針が求める観点だが、このセッションでは実行できていない。
