# テスト結果: DSPFMT でフィールドのオプション入力欄の下線が消えたり、罫線のみ表示される不具合の調査・修正

## 実行したもの

- `npm run lint`（monorepo 全体、CI と同一コマンド）— エラー無し。
- `npm run build`（monorepo 全体、`tsc -b` + web-ui の `vue-tsc`）— エラー無し。
- `npm test`（monorepo 全 workspace、CI と同一コマンド）— 全て green、failed 0:
  - server: 1416 passed + 3 skipped
  - tn3270: 254 passed + 38 skipped
  - tn5250: 588 passed（T2 で追加した1ケース分、587→588）
  - vt: 202 passed
  - web-ui: 2035 passed
  - gen-tables: 10 passed
  - hostserver-check: テストファイル無し
  - その他の小規模パッケージも含め全 workspace で failed 0。
- `aidev smoke` — pass（exit 0）。

## 受け入れ基準ごとの判定

- ~~AC1~~ / ~~AC2~~: `decisions.md` D1 により撤去済み。この巡では判定しない。
- AC3: pass — `research.md` F5・F6 に、実機トレースで試した具体的な条件
  （WRKOBJPDM の Opt 欄、F1 ヘルプ窓の開閉、PageDown／DDS コンパイルでの全色 CS 検証）
  と結果（下線消失は再現せず、DDS コンパイルは通ったが実行時確認は未達）が記録されている。
  次の調査の手掛かり（`QRPGLESRC` の整備、利用者の実機での直接確認）も記録済み。
- AC4: pass — 修正方針は `research.md` F7（コードの読解＋ tn5250j・GNU tn5250 という
  2つの独立した参照実装との突き合わせ）に基づく。推測のみに基づく修正ではない。
- AC5: pass — 既存の属性描画テスト8ファイルを実行し、全て green のままであることを
  確認した（詳細は下記「実行したもの」）。
  - tn5250側: `field-attr-bound.test.ts`, `screen-buffer-attr-bounds.test.ts`,
    `wdsf-grid-border.test.ts`, `continued-field-attr.test.ts` — 4ファイル42件 pass。
  - web-ui側: `screen-grid-colsep.test.ts`, `grid-input-underline.test.ts`,
    `screen-grid-embedded-attr.test.ts`, `screen-grid-gridlines.test.ts` —
    4ファイル39件 pass。
- AC6: pass — WEA が DSPFMT 系画面で実際に使われているかは実機トレースでは
  未確認のまま（`research.md` F5——WRKOBJPDM・F1ヘルプ窓のシナリオでは一度も出現しなかった）
  だが、**使われた場合に確実に発生していた欠陥**（WEA 以降の同一 WTD 内の全オーダー消失）を
  修正し、`packages/tn5250/test/wtd-applier.test.ts` に追加した回帰テストで固定化した。
  修正前のコードに対してこのテストが実際に失敗すること（discrimination）を
  `git stash` で一時的に確認済み
  （`AssertionError: expected 'unknown order 0x12 — skipping to next…' to contain 'WEA'`）。

## 失敗の証跡

このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789433261782,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789433261801,"host":"127.0.0.1","port":44653,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 44653)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は新しい入口（サブコマンド・CLI オプション等）を追加していない
（既存のプロトコル層のオーダー処理内部の変更のみ）ため、`smokeCommands` への
追記は不要と判断した。

## 未検証の穴（skip / 環境不足）

- **WEA が実際に DSPFMT 系画面（またはその他の実運用画面）で使われているかは
  未確認のまま**（`research.md` F5）。今回試した実機シナリオ（WRKOBJPDM + F1ヘルプ窓 +
  PageDown）では一度も出現しなかった。修正は「使われた場合に確実に発生する欠陥」を
  直したものであり、利用者が報告した具体的な症状（下線消失・罫線のみ表示）を
  解消するという確証は無い（`decisions.md` D1）。
- **黄・青緑以外の色での桁区切りの実際の送信経路**（WEA 経由か、単に無視されるだけか）は
  実機に RPG コンパイル用のソースファイル（`QRPGLESRC`）が現在存在せず確認できなかった
  （`research.md` F6）。DDS コンパイル自体は全7色で通ることを確認済み。
- 上記2点は `.aidev/backlog/acs-parity.md` の該当項目に、次の調査ステップとして
  引き継ぐ（deliver 工程で反映する）。
