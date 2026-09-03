---
backlog: aid-response-timeout
kind: standing
---

# AID 応答タイムアウト（既定 30 秒）を廃止できるか

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

## 落とし所の案

- **対話（ws）**: 応答タイムアウトを無くす。🔒 とスピナーを出したまま待ち、
  抜けたいときは Attn / SysReq（2）。実機・ACS・tn5250j・lib5250 と同じ形になる
- **自動操作（MCP / HLLAPI / マクロ）**: **上限は残す**。呼び出しは必ず値を返さねばならず、
  HLLAPI は時間切れを `PS_BUSY`（rc=4）で返す約束、MCP `send_key` も `timedOut` を返す口がある。
  ただし既定 30 秒は短い（バッチ処理を呼ぶ用途で普通に超える）ので、設定で伸ばせるようにする
- タイムアウトで **`state = "ready"` に戻すのはやめる**。施錠はホストの事実であって、
  こちらの都合で偽ってよいものではない。戻さないなら Attn / SysReq の口が要る（上と同じ前提）

## 関連

- `20260726-attn-sysreq-cancel-invite`（方針 5・施錠中の送信を見送った経緯）
- `datastream-commands.md`（未実装コマンドで READ ごと捨てて「応答が無い」に見える別口）
