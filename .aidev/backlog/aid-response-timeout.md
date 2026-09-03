---
backlog: aid-response-timeout
kind: standing
---

# AID 応答タイムアウト（既定 30 秒）を廃止できるか → **廃止した**（2026-09-03）

`Session5250.sendAndWait` は AID 送信後 **30 秒**で待ちを打ち切り、`timedOut: true` で
その時点の画面を返す（`packages/tn5250/src/session/session.ts` の `sendAndWait`）。
`ws-handler.onKey` は `timeoutMs` を渡さないので、**ブラウザの操作もこの 30 秒に乗っている**。

## 何が困るか

時間の掛かるプログラムを CALL すると、30 秒でこうなる:

- `key-done timedOut` → 画面最下行に `MSG_NO_RESPONSE`「ホストから応答がありませんでした」。
  **プログラムはまだ走っている**ので、この通知は嘘になる
- `sendAndWait` が `this.state = "ready"` に戻すため、**スナップショットが施錠を偽る**。
  OIA の 🔒 が消え、入力プロテクトも外れ、次の AID が `assertReady` を通ってしまう
  ——ホストは Read を出していないので、実機なら送ってはいけないレコードになる

## 原典はどうか（2026-09-03 に裏を取った）

**どちらの参照実装にも、AID 応答の打ち切りタイマーは無い。**

- **tn5250j**（Java・`tnvt.java` を読んだ）: 送信時に `setKeyBoardLocked(true)` を立て、
  解除はホスト由来の `pendingUnlock` 経路だけ。timeout 定数も `Thread.sleep`／`Timer` も無い
- **lib5250 / tn5250**（C・`lib5250/session.c` を読んだ）: AID 送信で
  `TN5250_DISPLAY_IND_X_SYSTEM` を立て `keystate = LOCKED`。解除は `tn5250_session_read_cmd()` で
  ホストの応答を読んだときだけ。`select()` のタイムアウトも alarm も無い
- **IBM 5250 の OIA**: `II`（Input Inhibited）は「IBM i がキーボード入力を受け付けていない」印で、
  ドキュメントの指示は *"Try pressing the ERROR RESET key. **If still highlighted, the system is
  processing your request.**"* ——**点いたまま待つのが正常**（Microsoft, 5250 client status line）
- **固まった要求から抜ける口はタイマーではなく System Request**。SysReq の
  「2. 前の要求の終了」が、長く走っている要求を切る標準の手段（IBM Documentation）

つまり「時間で諦めて施錠を解く」のは**当実装だけの発明**で、実機の見え方から外れている。

## 廃止の前提（ここが本題）

いま 30 秒タイマーを外すと、**利用者に逃げ道が無くなる**。
`20260726-attn-sysreq-cancel-invite/spec.md` の方針 5 が挙げたとおり、施錠中の送信には
3 つの壁があり、Attn も SysReq も通らない:

1. `Session5250.pendingAid` が 1 本しか持てない
2. `session-controller.sendKey` の早期 return（いまは `inputInhibited` で施錠も見る）
3. `sendAid` が入口で `assertReady()` を投げる

同 spec は 30 秒タイマーを明示的に「現状の安全弁」と書いている。**安全弁を外すなら、先に
Attn / SysReq を施錠中でも通す**（＝方針 5 の見送りを解く）のが順序。

## 落とし所

- [x] **対話（ws）**: 応答タイムアウトを無くした。🔒 とスピナーを出したまま待ち、
  抜けたいときは Attn / SysReq（2）。実機・ACS・tn5250j・lib5250 と同じ形
  （`packages/server/src/ws-handler.ts` の `onKey`＝`timeoutMs: "never"`）
- [x] **自動操作（MCP / HLLAPI / マクロ）**: 上限は残した。呼び出しは必ず値を返さねばならず、
  HLLAPI は時間切れを `PS_BUSY`（rc=4）で返す約束。既定 30 秒が短い件は
  MCP `send_key` に `timeoutMs`（最大 1 時間）を足して伸ばせるようにした
  （`packages/server/src/mcp-tools.ts`）
- [x] タイムアウトで **`state = "ready"` に戻すのをやめた**（`session.ts` の `sendAndWait`）。
  施錠はホストの事実で、こちらの都合で偽ってよいものではない
- [x] **前提だった「施錠中の Attn / SysReq」を通した**（`session.ts` の `sendAid`＝
  フラグレコードは `assertNotClosed` だけ）。`20260726-attn-sysreq-cancel-invite` の方針 5 を解いた。
  併せて ws は**フラグキーに欄を書かない**（`setField` が施錠中に投げ、打ちかけの入力だけで
  逃げ道が塞がるため）／**`key-done` を返さない**（返すと元の待ちの busy が解ける）
- [x] 30 秒で嘘をつく代わりに**事実だけを言う通知**を置いた
  （`MSG_WAITING_LONG`＝「ホストの応答を待っています（Attn / SysReq で中断できます）」）。
  黙って待たせ続けると「時間の掛かる処理」と「本当に固まった」を利用者が区別できない

### 実機で確かめた（2026-09-03・`scripts/verify-aid-no-timeout.mjs`・8/8 OK）

日本語 IBM i（`AS400_SYSTEM`）に `DLYJOB DLY(60)` を投げて実測:

| 見たこと | 結果 |
|---|---|
| 送信 5 秒後、ホストは施錠しているか | 施錠 |
| 35 秒（旧実装が諦めていた 30 秒の後）で待ちを打ち切らないか | 打ち切らない |
| 同じ時点で施錠が解けていないか | 解けていない |
| 施錠中の Attn が `KEYBOARD_LOCKED` を投げないか | 投げない（ホストも応じた） |
| 施錠中の SysReq「2」が通り、走っている要求を切れるか | 切れて、待っていた AID が解決した |

## 関連

- `20260726-attn-sysreq-cancel-invite`（方針 5・施錠中の送信を見送った経緯）
- `datastream-commands.md`（未実装コマンドで READ ごと捨てて「応答が無い」に見える別口）
