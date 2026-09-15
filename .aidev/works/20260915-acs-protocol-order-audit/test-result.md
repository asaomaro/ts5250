# テスト結果: ACS のコア実装（DS5250/PS5250）と突き合わせた5250プロトコル処理の棚卸し（第1弾）

## 実行したもの

- `npm run lint`（monorepo 全体、CI と同一コマンド）— エラー無し。
- `npm run build`（monorepo 全体、`tsc -b` + web-ui の `vue-tsc`）— エラー無し。
- `npm test`（monorepo 全 workspace、CI と同一コマンド）— 全て green、failed 0:
  - server: 1416 passed + 3 skipped
  - tn3270: 254 passed + 38 skipped
  - tn5250: 588 passed（main ブランチの基準 587 + この work の新規1ケース）
  - vt: 202 passed
  - web-ui: 2035 passed
  - gen-tables: 10 passed
  - hostserver-check: テストファイル無し
  - その他の小規模パッケージも含め全 workspace で failed 0。
- `aidev smoke` — pass（exit 0）。

## 受け入れ基準ごとの判定

- AC1: pass — `wtd-applier.test.ts` の新規テスト「ORDER.UNKNOWN_1E は ';' 1 文字を
  表示し、後続の表示データ・オーダーを取りこぼさない」で、0x1E が `;` へ置換され、
  後続の SF・データが正しく適用されることを確認。修正前のコードに対してこの
  テストが実際に失敗すること（discrimination）を `git stash` で一時的に確認済み。
- AC2: pass — `ORDER.UNKNOWN_1C` の doc コメントを、ACS のデコンパイル済みソース
  （`research.md` F2, F3）に基づいて更新した（「正体未確認・要再確認」の記述を
  削除し、確認済みの事実に置き換え済み）。対応する既存テストの docstring も
  同じ内容に更新した（タスク横断点検で指摘、対応済み）。
- AC3: pass — `research.md` F1 に、ACS のオーダー switch と `wtd-applier.ts` の
  対応関係の一覧が記録されている（両者は1:1で一致）。
- AC4: pass — この work の全ての判断は `research.md` F1〜F6（ACS のデコンパイル
  済みソースコードの直接引用、tn5250j という独立した参照実装との突き合わせ）に
  基づく。推測に基づく判断は無い。
- AC5: pass — `ORDER.UNKNOWN_1C` の既存テスト・実機 fixture を使うテスト
  （`pub400-signon.jsonl` 等）は無関係のまま green を維持。「未知オーダーの後、
  SBA のパラメータを ESC と読み違えない」テストは 0x16 へ差し替え、同じ検証内容
  （ESC 誤認識の回避）を維持したまま green。

## 失敗の証跡

このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789437583472,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789437583486,"host":"127.0.0.1","port":44829,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 44829)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は新しい入口（サブコマンド・CLI オプション等）を追加していない
（既存のプロトコル層のオーダー処理内部の変更のみ）ため、`smokeCommands` への
追記は不要と判断した。

## 未検証の穴（skip / 環境不足）

- **0x1E が実機で実際に送られてくることは確認できていない**（`research.md` F6）。
  ACS のデコンパイル済みソースコードの読解のみに基づく発見であり、修正が
  利用者が実際に遭遇する不具合を解消するかどうかは未検証。WEA の修正
  （`20260914-dspfmt-field-underline-instability`）と同様、「遭遇すれば確実に
  問題を起こす、確認済みの欠陥」を予防的に塞ぐという位置づけ。
- `ORDER.UNKNOWN_1C`/`UNKNOWN_1E` のアーキテクチャ上の位置づけ（「オーダー」では
  ないものをオーダー switch の枠組みで扱っている）の見直しはこの work のスコープ
  外（`decisions.md` D1）。将来の機会に持ち越す。
