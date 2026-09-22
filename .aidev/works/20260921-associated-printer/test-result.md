# テスト結果: 関連付けプリンター（IBMASSOCPRT）

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `cd packages/tn5250 && npx vitest run test/associated-printer.test.ts test/telnet.test.ts test/startup-reject.test.ts` — 47 passed / 0 failed
- `cd packages/server && npx vitest run test/config-associated-printer.test.ts test/config-resolver.test.ts test/config-store.test.ts test/config-routes.test.ts test/config-watermark.test.ts test/dtaq-watch-config.test.ts` — 95 passed / 0 failed
- `cd packages/web-ui && npx vitest run test/config-card-associated-printer.test.ts test/config-card-terminal.test.ts test/config-card-idle-timeout.test.ts test/config-card-ownership.test.ts` — 38 passed / 0 failed
- mutation（`scratchpad/mut-ap.py`・16 件）— 全件 KILLED（1 件はテストを強めてから。下の証跡）

## 受け入れ基準ごとの判定
- AC1: pass — `associated-printer.test.ts`（最後に置く・自動サインオンの変数より後ろ・値を加工しない・下位 8 ビット・0xFF の二重化・空白だけなら送らない）。
- AC2: pass — `config-associated-printer.test.ts`（両方の保存先に書ける・5250 の表示以外は弾く・解決で 5250 の表示だけ渡す・手で書き換えたファイルでも混ぜない）。
- AC3: pass — `config-card-associated-printer.test.ts`（欄に開く・打ったまま送る・空なら送らない・5250 の表示だけに欄・3270 に切り替えたら送らない・詳細に出す）。
- AC4: pass — 実機（社内機・2026-09-21〜22）。ACS のコア（`acs-probe.mjs` に `PROBE_ASSOC_PRINTER`）と当 PJ（`Session5250` に `associatedPrinter`）を
  同じく `tap-proxy.mjs` 経由で当てた:

  | 関連付け | ACS のコア | 当 PJ |
  |---|---|---|
  | 無し | I902・印刷装置はシステム既定 | I902・システム既定 |
  | `.env.verify` の `AS400_PRTDEV` | I902・印刷装置はその装置 | I902・その装置 |
  | 存在しない名前 `NOSUCHPRT` | **I901**・システム既定のまま（接続・サインオンは通る） | **I901**・システム既定のまま |

  ワイヤはどちらも NEW-ENVIRON IS の**最後**に `USERVAR IBMASSOCPRT VALUE <装置名>`（値は同じバイト列）。ACS は同じ装置で 2 回（1 回目は値に `.env.verify` の
  行末コメントが混ざった回で、ACS はそれもそのまま送り、ホストは空白の手前までを装置名として使った）。記録（パスワードを含む）は解析後に削除した。
- AC5: pass — `associated-printer.test.ts` の「空・空白だけ・制御文字だけなら…1 バイトも変わらない」と、既存の `telnet.test.ts` の期待値（変更なし）。
- AC6: pass — mutation 16 件すべて KILLED。

## 失敗の証跡
このラウンドではテストの失敗は発生していない。mutation で 1 件生き残ったので、テストを強めてから回し直した:

```
$ python3 scratchpad/mut-ap.py
KILLED 空白だけでも送る :: 1 failed | 5 passed (6)
SURVIVED 下位 8 ビットにしない :: 6 passed (6)
KILLED 値の空白を落とす :: 1 failed | 5 passed (6)
...
$ python3 scratchpad/mut-ap1.py   # 0x1FF（IAC の二重化を逃れる文字）の検査を足した後
KILLED 下位 8 ビットにしない :: 1 failed | 5 passed (6)
```

原因: 送信時に `Uint8Array` へ詰める段で下位 8 ビットに切られるので、`& 0xff` を外しても `U+FF21` では差が出なかった。
差が出るのは下位が 0xFF になる文字（telnet の IAC の二重化を逃れて交渉が壊れる）なので、それを検査に足した。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 46641)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

新しい入口（サブコマンド・オプション）は足していないので `smokeCommands` は据え置く。

## 未検証の穴（skip / 環境不足）
- 全量テスト・lint・build（vue-tsc）・独立点検は節目でまとめて回す（利用者の方針）。
- ブラウザで設定カードから保存して実機に繋ぐ経路は通していない（ws の表示セッションは解決結果を `{...target.connect}` で渡す——`packages/server/src/ws-handler.ts:570`）。
- プリンターセッションを指す関連付け・I901 の表示は対象外（台帳へ割った。decisions D2）。

## 節目 10 の対応（ラウンド 2 の指摘を直した回）

### 実行したもの
- `npm test`（全量）— 6,619 passed / 0 failed / 41 skipped（10 ワークスペース）
- `npm run lint` — exit 0 / `npm run build`（web-ui の `vue-tsc` を含む）— exit 0（途中の 1 回は `field-exit-checks-wiring.test.ts` の型で落ち、`NonNullable<Field["dbcsType"]>` に直した）
- mutation（`scratchpad/mut-c10.py`）— コードポイント単位に戻す 1 通りが落ちた

### 受け入れ基準の再確認
- AC1〜AC3: pass（全量）

### 失敗の証跡
このラウンドの失敗は mutation の確認だけ: コードポイント単位に戻す変異は 1 failed | 6 passed (7) で落ちる（足したテストが固定）。直す前の点検役の再現は `"P😀"` が当 PJ `[80,61]`・ACS `[80,61,0]`。

### 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45959)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

### 未検証の穴
- 補助面の文字を実機で送ってはいない（ACS のコードの読みと単体まで）
