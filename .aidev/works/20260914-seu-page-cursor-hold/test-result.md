# テスト結果: SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を保持する

> **【3巡目で AC1/AC2/AC8 は撤去】** ACS のコア実装の調査結果を受け、これらの受け入れ基準を
> 満たすために実装した Rule1/Rule2 専用ロジックを撤去した（`decisions.md` D7）。以下の
> 1巡目・2巡目の記録にある AC1/AC2/AC8 の pass 判定は、**撤去前の実装に対する当時の記録として
> そのまま残す**（何を検証してどう判定したかの経緯は消さない）。現在の判定は末尾の
> 「受け入れ基準ごとの判定（3巡目、Rule1/Rule2 撤去後）」を参照。

## 実行したもの（1巡目、PR #395 マージ前）

- `npx vitest run packages/tn5250/test/` — 594 passed / 0 failed / 0 skipped（62 ファイル）
- `cd packages/web-ui && npx vitest run test/screen-grid-cursor-restore.test.ts`
  — 5 passed / 0 failed / 0 skipped（web-ui は自パッケージの vitest 設定で実行する必要がある。
  ルートから素の `vitest run` すると `.vue` ファイルの transform に `@vitejs/plugin-vue` 不足で
  失敗する——今回の変更とは無関係な既知の実行方法）
- `npx tsc -b`（monorepo 全体のビルド）— エラー無し
- `npx eslint packages/tn5250/src/session/session.ts packages/tn5250/src/screen/buffer.ts packages/tn5250/test/cursor-page-boundary.test.ts packages/tn5250/test/cells-signature.test.ts`
  — エラー無し

## 実行したもの（2巡目、T7: deliver 後の利用者報告を受けた追加修正）

- `npx vitest run packages/tn5250/test/` — 597 passed / 0 failed / 0 skipped（62 ファイル。
  T7 で追加した3ケース分増加。内訳:
  - AC1/AC2/AC8「実機で報告された回帰（PageDown/PageUp）」— クリックで別の欄へ
    カーソルを移してから境界ページで PageUp/PageDown した場合、移した先
    （`opts.cursor`）が正しく維持されることを確認（`decisions.md` D5 の回帰そのもの）。
  - AC1/AC2「不正な cursor オプション」— 非整数値が `buf.cursorAddr` を壊さないことを、
    `sendAid` 呼び出し直後・応答到着前の同期区間で確認（`DeferredTransport` 使用）。
- `npm run lint`（monorepo 全体）— エラー無し（CI の `offline` ジョブと同一コマンド。
  1巡目では対象ファイルを絞ってしまい、`scripts/` の実機診断スクリプトの lint エラーを
  deliver 後の CI で検出する結果になった——教訓は `review.md` 参照）
- `npm run build`（monorepo 全体、`tsc -b` + web-ui の `vue-tsc`）— エラー無し
- `npm test`（monorepo 全workspace。CI と同一コマンド）—
  server: 1416 passed + 3 skipped、tn3270: 254 passed + 38 skipped、
  tn5250: 596 passed、vt: 202 passed、web-ui: 2035 passed、gen-tables: 10 passed、
  hostserver-check: テストファイル無し。**すべて failed 0**。
  - 1回だけ `packages/web-ui/test/tab-visibility.test.ts` がタイムアウトで失敗したが、
    今回の変更（`session.ts`/`buffer.ts`/`packages/tn5250/test/`）とは無関係なテスト
    （タブの表示/折りたたみ UI）。ACS jar のデコンパイル作業でシステム負荷が高い
    タイミングと重なったための一時的な事象と判断し、単体実行・`main` 相当のコミット
    （このT7修正を `git stash` した状態）の両方で再現しないことを確認した。
    再現した場合は別途 flaky として扱う（この work の対象外）。

## 受け入れ基準ごとの判定（1巡目時点。T7 適用後も判定は変わらず pass のまま）

**T7 の位置づけ**: PR #395 マージ後、利用者が実機（web-ui）で PageUp を試したところ
改善していないとの報告があった。原因は `sendAid()` の `opts.cursor`（web-ui のクリックを
伝える経路）が `buf.cursorAddr` を更新しておらず、クリックで別の欄へ移してから
（別の AID を挟まずに）PageUp/PageDown すると `cursorBefore` が古い位置のままだったこと
（`decisions.md` D5）。AC1・AC2 は元々「境界でカーソル位置が維持される」ことを求めており、
T7 はその維持対象の基準点（送信前の位置）を正しく捉える修正なので、AC の文言・番号は
変わらない。`cursor-page-boundary.test.ts` に専用の回帰ケース（クリック後 PageDown、
および不正な cursor 値のガード）を追加した。

- AC1: pass — `cursor-page-boundary.test.ts`「AC1/AC8 Rule2 (PageDown)」
  「AC1 Rule1 (PageDown)」で、PageDown で最終ページ（境界）に到達する2パターン
  （画面完全一致／着地先が入力不可）双方でカーソル位置が送信前のまま維持されることを確認。
  さらに、ガードとなる `cursorBeforeWasEnterable` を一時的に無効化するとこの2ケースが
  実際に失敗することを手動で確認済み（`review.md`「タスク点検ログ」T3参照）。
- AC2: pass — 同ファイル「AC2 Rule1」「AC2 Rule2」で、PageUp でも同じ2ルールが
  対称に効くことを確認（横断点検の指摘を受けて Rule2 側のケースも追加済み）。
- AC3: pass — 同ファイル「AC3: 途中ページ（非境界）遷移では、ホストの IC をそのまま
  適用する」で、非境界遷移では新しい分岐が発火せず既存の正しい挙動のままであることを確認。
- AC4: pass — `research.md`（F1〜F6）に実機トレースでの原因確認の記録が存在することを
  T6 で再確認済み。
- AC5: pass — `packages/tn5250/test/cursor-default.test.ts`（594件に含まれる、
  既存の F1ヘルプ/27x132切替のカーソル既定移動テスト）が green のまま。新しい分岐は
  AID キー種別（PageUp/PageDown 以外）で排他されるため無関係。
- AC6: pass — `packages/tn5250/test/cursor-stale-on-protected.test.ts`（既存、594件に含む）
  に加え、`cursor-page-boundary.test.ts`「AC6 回帰」で PageUp/PageDown 発火時特有の
  重なり（`cursorBeforeWasEnterable` が無いケース）も個別に確認。ガードを一時的に
  無効化するとこのケースが失敗することを確認済み（タスク横断点検で指摘され追加した観点）。
- AC7: pass — `packages/web-ui/test/screen-grid-cursor-restore.test.ts`（既存）が green。
  走査検索は `Enter` で実行されるため新しい分岐と無関係。
- AC8: pass — `cursor-page-boundary.test.ts` を新規追加（7ケース）。実機接続なしで
  完結する合成 WTD ベースの統合テスト（`tasks.md`「テスト方針」の通り）。

## 実行したもの（3巡目、Rule1/Rule2 撤去。`decisions.md` D7）

利用者から「専用ロジックが ACS に無かったのであれば削除してください」との明示的な指示を
受け、`decisions.md` D6（ACS コアのデコンパイル調査）を踏まえて Rule1/Rule2・`lastSentAid`・
`cellsSignature()` を撤去し、既存の2分岐のみの元の設計へ戻した（`tasks.md` T8）。
T7（AC9、`sendAid` の `opts.cursor` 同期）は独立したバグ修正として維持し、その回帰テストを
`cursor-page-boundary.test.ts` から `sendaid-cursor-sync.test.ts` として独立させた。

- `npm run lint`（monorepo 全体、CI の `offline` ジョブと同一コマンド）— エラー無し。
- `npm run build`（monorepo 全体、`tsc -b` + web-ui の `vue-tsc`）— エラー無し。
- `npm test`（monorepo 全 workspace、CI と同一コマンド）— 全て green、failed 0:
  - server: 1416 passed + 3 skipped
  - tn3270: 254 passed + 38 skipped
  - tn5250: 587 passed（0 failed。Rule1/Rule2・cellsSignature 専用テスト計10ケースを削除し、
    `sendaid-cursor-sync.test.ts` の3ケースを追加した結果の件数）
  - vt: 202 passed
  - web-ui: 2035 passed（2巡目で1度だけ発生した `tab-visibility.test.ts` のタイムアウトは
    今回は再発せず、全ファイル green）
  - gen-tables: 10 passed
  - hostserver-check: テストファイル無し
  - その他（client 等の小規模パッケージ）も含め全 workspace で failed 0。
- `aidev smoke` — pass（exit 0。下記「起動確認」参照）。

## 受け入れ基準ごとの判定（3巡目、Rule1/Rule2 撤去後）

- ~~AC1~~ / ~~AC2~~ / ~~AC8~~: **`requirements.md` から撤去済み**（`decisions.md` D7）。
  検証対象が消滅したため、この巡では判定しない。目標は
  `.aidev/backlog/acs-parity.md` へ引き継いだ。
- AC3: pass — Rule1/Rule2 という新ルールが存在しない元の2分岐のみで、途中ページ
  （非境界）遷移は変更前と同じ経路（ホストの IC がそのまま適用される）を通る。
  `packages/tn5250/test/session.test.ts` 等、既存の一般的な WTD 適用テスト群が
  green のままであることで確認（新しい分岐そのものが存在しないため、退行しようがない
  ——`design.md`「受け入れ基準との対応」AC3 参照）。
- AC4: pass — `research.md`（F1〜F6）に実機トレースでの原因確認の記録が存在する
  （撤去の判断とは独立に、事実の記録としてそのまま有効）。
- AC5: pass — `packages/tn5250/test/cursor-default.test.ts`（既存、F1ヘルプ/27x132切替の
  カーソル既定移動テスト）が green。Rule1/Rule2 撤去によりコードは変更前
  （T3 導入前）の状態に戻っており、このテストは元々一度も壊れていない。
- AC6: pass — `packages/tn5250/test/cursor-stale-on-protected.test.ts`（既存、`PR#387`）が
  green。Rule1/Rule2 撤去によりこの分岐との重なりの懸念（`decisions.md` D4）自体が消滅した
  （新ルールが存在しないため、そもそも重なりようがない）。
- AC7: pass — `packages/web-ui/test/screen-grid-cursor-restore.test.ts`（既存）が green。
  Rule1/Rule2 と無関係なため影響なし。
- AC9: pass — `packages/tn5250/test/sendaid-cursor-sync.test.ts`（新規、3ケース）で、
  (1) クリック後 PageDown で `opts.cursor` の位置が正しく維持される、(2) 同じ経路が
  PageUp でも対称に働く、(3) 不正な cursor 値（非整数）が `sendAid` 呼び出し直後・
  応答到着前の内部状態を壊さない（`DeferredTransport` で同期区間を直接観測）、
  の3点を確認。(3) は当初の `try/catch` ガードでは検出できず、`Number.isInteger` +
  範囲チェックへの修正後に green になることを確認済み（タスク単位の独立点検の
  `must` 指摘で発見。`review.md`「タスク点検ログ」T7 参照）。

## 失敗の証跡

このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789429017072,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789429017100,"host":"127.0.0.1","port":44947,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 44947)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は新しい入口（サブコマンド・CLI オプション等）を追加していない
（既存のセッション処理内部のカーソル制御ロジックのみの変更）ため、`smokeCommands` への
追記は不要と判断した。

## 未検証の穴（skip / 環境不足）

- ~~**IBM ACS との実機同時比較は未実施**（`decisions.md` D1）。~~
  **3巡目で決着（`decisions.md` D6, D7）**: ACS 本体（`acsbundle.jar`）のコアクラス
  （`DS5250`/`PS5250`）をデコンパイルして確認したところ、「IC/MC 欠落時は最初の入力欄へ」
  という既定動作は当プロジェクトと同じ設計だったが、「PageUp/PageDown 境界でホストの IC
  より前の位置を優先する」という Rule1/Rule2 に相当する専用ロジックはコアには見当たらず、
  利用者の指示により Rule1/Rule2 自体を撤去した。UI 描画層の追加調査・実機同時比較が
  必要かどうかを含め、元の目標（AC1/AC2/AC8）は `.aidev/backlog/acs-parity.md` へ
  引き継いだ（この work では再挑戦しない）。
- ~~**PageUp/PageDown 以外のロールキーでの類似不具合**（`decisions.md` D2）~~
  **Rule1/Rule2 撤去により対象自体が消滅**——他のロールキーへの影響も含め、
  境界でのカーソル制御に関する専用ロジックがそもそも無くなったため、この懸念は解消した。
- ~~**`cellsSignature()` が FFW（保護ビット）を追跡しない残存リスク**、および
  **`lastSentAid` が Attn/SysReq を挟んだ場合に生じうる誤判定**（`decisions.md` D4）~~
  **Rule1/Rule2 撤去により両方とも解消**——`cellsSignature()` と `lastSentAid` 自体を
  削除したため、これらに起因するリスクは構造的に存在しなくなった。
- **今回の作業とは無関係な別件の不具合報告**（利用者、2026-09-15）: DSPFMT でフィールドの
  オプション入力欄の下線が消えたり罫線のみ表示されることがある、および最近の接続状態
  維持・再接続対応以降に操作の待ち時間が不安定になっている、との報告があったが、
  いずれもこの work のスコープ外と判断し検証していない
  （`.aidev/backlog/acs-parity.md`・`.aidev/backlog/session-lifecycle.md` へ新規項目として
  起票済み。`decisions.md` D7「影響」）。
