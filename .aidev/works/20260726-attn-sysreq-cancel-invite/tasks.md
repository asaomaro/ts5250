# タスク: Attn / SysReq を実際に機能させる

## core（プロトコル）

- [x] T1: `packages/core/src/protocol/read-response.ts` — `buildFlagRecord(flags, data?)` にデータ引数を足し、
      `buildCancelInviteAck()`（opcode `0x0A`・フラグ 0・データ無し）を追加する。原典
      （`org.tn5250j.framework.tn5250.tnvt#cancelInvite`）を参照コメントで残す
- [x] T2: `packages/core/src/session/session.ts` — `handleRecord` に `OPCODE.CANCEL_INVITE` 分岐を足し、
      ack を返して `state === "ready"` ならロックする。**無条件に返す理由**と**ack 後に return しない理由**を
      コメントで残す（依存: T1）
- [x] T3: `packages/core/src/session/session.ts` — `SendAidOptions.sysReqText` を追加し、`buildAidRecord` が
      SysReq のときだけデータに載せる。SysReq 以外に付いていたら `PROTOCOL_ERROR`。EBCDIC 変換の置換は
      既存と同じく `warn` に出す（依存: T1）
- [x] T4: `packages/core/test/read-response.test.ts` — データ付き SRQ レコードの hex 一致（実機採取値
      `001012a0000004040000c4e2d7d1d6c2`）と `buildCancelInviteAck()` のバイト列を検証（依存: T1）
- [x] T5: `packages/core/test/session.test.ts` — `ReplayTransport` で `tx`(Attn) → `rx`(Cancel Invite) →
      `rx`(unlock 付き画面) を並べ、ack が送出され `sendAid` が解決することを検証。
      `sysReqText` の誤用が `PROTOCOL_ERROR` になることも（依存: T2, T3）

## server（配線）

- [x] T6: `packages/server/src/ws-messages.ts` に `WsKey.sysReqText` を足し、`ws-handler.ts` の `onKey` から
      `sendAid` へ渡す（依存: T3）
- [x] T7: `packages/server/src/mcp-tools.ts` の `send_key` に `sysReqText`（任意）を足す（依存: T3）

## web-ui（操作）

- [x] T8: `packages/web-ui/src/session-controller.ts` — `sendKey` に `sysReqText` を足す（依存: T6）
- [x] T9: `packages/web-ui/src/components/SysReqLine.vue`（新規）— 画面下部のシステム要求行。
      等幅・CRT 配色（`docs/UI-DESIGN.md`）、桁数制限なし、Enter で `submit`・Escape で `cancel`、
      開いたら入力欄へフォーカス
- [x] T10: `packages/web-ui/src/components/EmulatorPane.vue` — SysReq を受けたら送信せず行を開く。
      行が開いている間は keydown を早期 return して 5250 のキー処理を止める。閉じたらペインへフォーカスを戻す。
      切断時は行を閉じる（依存: T8, T9）
- [x] T11: `packages/web-ui/src/components/StatusBar.vue` — `.fk` キー行に `Attn 割込`（即送信）と
      `SysReq システム要求`（`sysreq` を emit）を足す。`EmulatorPane` で受けて T10 の入口に合流させる（依存: T10）
- [x] T12: web-ui のコンポーネントテスト — `SysReqLine` の開閉・確定・取り消し／`EmulatorPane` で
      「開いただけでは送らない」「Escape で 1 度も送らない」「Enter で `sysReqText` 付きで送る」
      「行が開いている間 F キーが 5250 へ飛ばない」／`StatusBar` の 2 ボタン（依存: T9, T10, T11）

## ドキュメント・実機検証

- [x] T13: `docs/PROTOCOL.md` 6.2 に Cancel Invite の往復（ホスト `0x0A` → 端末 `0x0A`）と
      データ付き SysReq のバイト列を追記する（依存: T2, T3）
- [x] T14: `scripts/probe-sysreq.mjs` を、手動で ack を返していた部分を外して**本体の実装に任せる**形へ整理し、
      実機で Attn のコマンド入力窓と SysReq のシステム要求メニューを確認する（依存: T2, T3）
