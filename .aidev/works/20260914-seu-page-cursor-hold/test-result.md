# テスト結果: SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を保持する

## 実行したもの

- `npx vitest run packages/tn5250/test/` — 594 passed / 0 failed / 0 skipped（62 ファイル）
- `cd packages/web-ui && npx vitest run test/screen-grid-cursor-restore.test.ts`
  — 5 passed / 0 failed / 0 skipped（web-ui は自パッケージの vitest 設定で実行する必要がある。
  ルートから素の `vitest run` すると `.vue` ファイルの transform に `@vitejs/plugin-vue` 不足で
  失敗する——今回の変更とは無関係な既知の実行方法）
- `npx tsc -b`（monorepo 全体のビルド）— エラー無し
- `npx eslint packages/tn5250/src/session/session.ts packages/tn5250/src/screen/buffer.ts packages/tn5250/test/cursor-page-boundary.test.ts packages/tn5250/test/cells-signature.test.ts`
  — エラー無し

## 受け入れ基準ごとの判定

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

## 失敗の証跡

このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789394053733,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789394053748,"host":"127.0.0.1","port":46007,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 46007)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は新しい入口（サブコマンド・CLI オプション等）を追加していない
（既存のセッション処理内部のカーソル制御ロジックのみの変更）ため、`smokeCommands` への
追記は不要と判断した。

## 未検証の穴（skip / 環境不足）

- **IBM ACS との実機同時比較は未実施**（`decisions.md` D1）。この環境に ACS が無く、
  ホストが境界ページで送る IC を ACS が額面通り受け入れているか、独自に無視しているかは
  今回の自動テスト・実機トレースのどちらでも検証できていない。requirements.md に明記された
  ユーザーの要望（見た目の挙動）を正として実装・テストしており、ACS 内部実装の完全な
  再現は検証対象にしていない。
- **PageUp/PageDown 以外のロールキーでの類似不具合**（`decisions.md` D2）は今回のスコープ外
  のため未検証（他のホストプログラムが別のロールキーで同様の境界挙動を持つ可能性）。
- **`cellsSignature()` が FFW（保護ビット）を追跡しない残存リスク**、および
  **`lastSentAid` が Attn/SysReq を挟んだ場合に生じうる誤判定**（`decisions.md` D4）は、
  実機トレースでは観測されておらず、自動テストでも意図的に再現していない
  （この work のスコープでは対応しないと確定済み）。
