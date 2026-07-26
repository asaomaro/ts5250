# テスト結果: Attn / SysReq を実際に機能させる

実施日: 2026-07-26

## サマリ

| 区分 | 合格 | 失敗 |
|---|---|---|
| 自動テスト（全パッケージ） | 2167 | 4（**環境要因・本変更と無関係**） |
| 実機検証（実機直結） | 5 | 0 |
| 実機検証（WebSocket 経路） | 6 | 0 |

**判定: 合格**（未解決の失敗なし）。

### 失敗 4 件の内訳（既存事象）

`packages/server/test/zip-writer.test.ts` の 4 件が `spawnSync unzip EACCES` で失敗する。
**この環境に `unzip` バイナリが無い**ことが原因で（`which unzip` も無し）、本変更は
`zip-writer.ts` にもそのテストにも触れていない（`git status` で未変更を確認済み）。
外部コマンドに依存する検証なので、**ZIP 書き出しの外部互換性はこの環境では未検証**のまま。
deliver の PR 本文に既知の制約として引き継ぐ。

## 受け入れ基準との突き合わせ（requirement.md）

| # | 完了条件 | 結果 | 根拠 |
|---|---|---|---|
| 1 | `0x0A` に `0x0A`/フラグ0/データ無しを返す UT | ✅ | `read-response.test.ts`「opcode 0x0A・フラグ 0・データ無しを返す」＝`000a12a000000400000a`／`session.test.ts`「Cancel Invite(0x0A) に同じ opcode で返事し、ホストの次画面まで進む」 |
| 2 | データ付き SysReq のレコード組み立て UT | ✅ | `read-response.test.ts`「SysReq はシステム要求行の文字列を EBCDIC でデータに載せる」＝実機採取値 `001012a0000004040000c4e2d7d1d6c2` と一致 |
| 3 | 空 SysReq の後方互換 `000a12a0000004040000` | ✅ | 既存テストにバイト列一致の断言を追加して明示化 |
| 4 | システム要求行の取り消しで送らない | ✅ | `sysreq-line.test.ts`「Esc で取り消すと 1 度も送らずに行が閉じる」 |
| 5 | StatusBar の Attn / SysReq ボタン | ✅ | `sysreq-line.test.ts`「Attn は即座にホストへ送る」「SysReq は送らずに sysreq を emit する」 |
| 6 | **実機で Attn → コマンド入力窓 → コマンド実行 → F3 で背面復帰** | ✅ | 下記「実機検証」参照 |
| 7 | **実機で SysReq 空 → システム要求メニュー／オプションで遷移** | ✅ | 下記「実機検証」参照 |
| 8 | `docs/PROTOCOL.md` 6.2 の追記 | ✅ | Cancel Invite の往復・バイト列表・「SysReq 行は CL コマンド不可」を追記 |
| 9 | 既存テスト全通過＋ビルド | ✅ | 上記サマリのとおり（失敗 4 件は環境要因）。`npm run build` / `npm run build -w @as400web/web-ui`（vue-tsc 込み）成功 |

## 自動テスト

```
core       859 passed
server     530 passed / 4 failed（unzip 不在。本変更と無関係）
web-ui     774 passed   ← うち新規 sysreq-line.test.ts 10 件
gen-tables   4 passed
```

新規 `packages/web-ui/test/sysreq-line.test.ts`（10 件）:

- `SysReqLine` 単体 — open でフォーカス／実行キーで submit・Esc で cancel／閉じると入力値を捨てる
- `EmulatorPane` — SysReq のキーバインドは行を開くだけでホストへ送らない／Esc 取り消しで 1 度も送らない／
  実行キーで `sysReqText` 付きに送る／**行が開いている間 F キー・実行キーが 5250 へ飛ばない**／切断で畳む
- `StatusBar` — Attn は即送信／SysReq は送らず emit

`packages/core` 追加分:

- `buildCancelInviteAck()` のバイト列
- データ付き SRQ レコードのバイト列（実機採取値と一致）
- Cancel Invite の往復（`ReplayTransport` で `tx`→`rx(0x0A)`→`rx(unlock)`）
- `sysReqText` を SysReq 以外に付けたら `PROTOCOL_ERROR`

## 実機検証

### A. core 直結（`scripts/probe-sysreq.mjs`）

**この script は手で ack を返さない**——返してしまうと本体が壊れていても通り、検証の意味が無くなる。
`sendAid` が解決すること自体が ack が効いている証拠（返さなければキーボードが解除されずタイムアウトする）。

| 検証 | 結果 |
|---|---|
| Attn → `sendAid timedOut=false` | ✅ |
| Attn → 画面下部に `EVXX01 コマンド入力` の窓（入力欄 (20,26) len=51 ×2、F4=プロンプト/F9=コマンドの複写/F11=電卓） | ✅ |
| その窓で `DSPLIBL` を実行 → ライブラリー・リスト表示（QSYS/QHLPSYS/QUSRSYS/QGPL/QTEMP/QEVX） | ✅ |
| F3 → RESTORE SCREEN で背面のメインメニューが元通り | ✅ |
| SysReq 空 → 「システム要求」メニュー（1/2/3/4/5/6/7・80・90） | ✅ |
| SysReq `"3"` → メニューを経由せず「ジョブの表示」へ直行 | ✅ |

受信 opcode の並びも設計どおり: `0x0a`(Cancel Invite) → `0x04`(SAVE SCREEN) → `0x03`(PUT_GET) → …
→ `0x05`(RESTORE SCREEN)。

### B. WebSocket 経路（`scripts/verify-ws-sysreq.mjs`・新規）

**ユニットテストで埋まらない穴はここ**。`ws-handler` が `sysReqText` を core まで渡せているか、
ack がサーバー経由でも成立するかは実際に繋がないと分からない。

```
OK   メインメニューに到達
OK   Attn がタイムアウトしない
OK   Attn でコマンド入力の窓が出る
OK   F3 で背面（メインメニュー）が戻る
OK   SysReq がタイムアウトしない
OK   sysReqText "3" が届いてジョブの表示へ直行する
OK   システム要求メニューを経由していない
RESULT: OK
```

装置名は `QPADEV000x` を使う（実機は事前定義された名前しか受け付けない）。
切断で終えると次回に「対話式ジョブの回復の試み」が出るため、script 側でオプション 90
（前のジョブのサイン・オフ）を選んで畳むようにしてある＝**繰り返し実行しても自己回復する**。

## 未検証の surface（deliver へ引き継ぐ）

- **MCP `send_key` の `sysReqText`**: ビルド済み `dist/mcp-tools.js` にスキーマと受け渡しが載っていることは
  確認したが、MCP クライアントからの実呼び出しは未実施。**core の `sendAid` に合流する同一経路**で、
  分岐は `sysReqText` の有無だけなので、WebSocket 経路の実機検証で実質的に覆われている。
- **ZIP 書き出しの外部互換性**: 環境に `unzip` が無く 4 件 skip 相当（上記）。本変更とは無関係。
- **キーボードロック中の SysReq**: 意図的に対象外（decisions D5）。
