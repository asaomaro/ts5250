# 決定記録（02-server-dtaq）

## D1: エラー応答の CPF 位置は実機で確認できた（core の D1 の宿題を解消）

- 背景: 01-core の decisions D1 で「エラー応答 0x8002 の CPF メッセージ位置は実機未採取。
  `parseCpfId` は位置非依存の走査で逃げてある」と申し送っていた。
- 決定/事実: 02 の実機 e2e で、削除済みキューに `attributes` を投げると
  **`[404] {"error":"attributes failed (rc=0xf001, CPF9801)","code":"NOT_FOUND"}`** が返った。
  0x8002 エラーフレームは実際に CPF9801 を載せており、走査で拾えて NOT_FOUND→404 まで通った。
  **位置非依存の走査が実バイトで機能することを確認**。追加のオフセット決め打ちは不要。

## D2: MCP の receive 待機上限は定数（deps に載せない）

- 背景: HTTP ルートは `deps.receiveMaxWaitSec`（CLI 可変）でクランプする。MCP ツールも同じ歯止めが要る。
- 決定: MCP の `host_dtaq_receive` は `DEFAULT_DTAQ_RECEIVE_MAX_WAIT_SEC`(60) で固定クランプ。
  `ToolDeps` に待機上限を足さない。
- 理由: MCP サーバーの `ToolDeps` は CLI の上限設定を運んでいない。MCP から無限待ちを作らせない
  という不変条件さえ守れれば十分で、MCP 側だけ可変にする必然性が無い。定数を `host-dtaq.ts` から
  import して二重定義を避けた（app.ts も同じ定数を import。循環参照を避けるため定数の置き場は host-dtaq.ts）。

## D3: 無限待ち（wait=-1）は HTTP/MCP から作らせない

- 背景: core は wait<0 で無限待ちできる（transport 改修の成果）。だが HTTP から無制限に許すと接続が張りっぱなし。
- 決定: 受信スキーマは `wait: z.number().int().min(0)`（負値は 400 で弾く）＋上限クランプ。
  無限待ちは **core API だけ**に残す（spec の方針どおり）。
- 影響: UI/MCP からは「最大 N 秒待つ」に制限される。長時間の待受が要る用途は core を直接使う。

## D5: MCP も受信待機上限を尊重する（D2 を差し替え・review 指摘）

- 背景: D2 は「MCP は定数 60 でクランプ、`ToolDeps` に載せない」とした。だが独立レビューで、
  operator が `--dtaq-max-wait 5` で締めても **MCP 経路だけその上限が効かず 60 秒まで待てる**と指摘された
  （歯止めが /mcp で無効化される）。
- 決定: `ToolDeps` に `dtaqReceiveMaxWaitSec?` を足し、MCP の `host_dtaq_receive` は
  `deps.dtaqReceiveMaxWaitSec ?? 既定` でクランプする。HTTP（buildApp のクランプ済み値）と stdio
  （buildDeps 経由、CLI は parseLimit 検証済み）の両方から配線。**D2 を差し替え**。
- 理由: 無限待ちの禁止（hard invariant）は両サーフェスで守れていたが、設定で締める上限（soft）が
  MCP に届かないのは operator の意図を裏切る。両サーフェスの挙動を揃える。

## D6: MCP create も KEYED/keyLength 整合を弾く（review 指摘）

- 背景: HTTP ルートは KEYED で keyLength 欠落／非 KEYED で keyLength 付与を 400 で弾くが、
  MCP の `host_dtaq_create` は検査せず core に素通ししていた（同じ論理操作で挙動が食い違う）。
- 決定: MCP create にも同じ 2 つの検査を入れ、CONFIG_ERROR で弾く（接続を開く前に）。
- 理由: 同じ操作は 2 サーフェスで同一に検証されるべき。非 KEYED + keyLength は core 未検証の組合せ。

## D7: base64 は黙って切り詰めず明示的に弾く（review 指摘）

- 背景: `Buffer.from(text, "base64")` は不正文字を無視して**意図と違うバイト列**を作る。
  バイナリ送信の footgun（送った内容と積まれた内容が食い違う）。
- 決定: `toBytes` の base64 経路で、空白除去後に `length%4===0` と文字集合を検査し、
  不正なら `CONFIG_ERROR`。変換を `withDtaq` の中に移し、`statusOf` が 400 に写せるようにした。
- 影響: 送信/クリア/受信キーの base64 入力が対象。実機 e2e で `!!!!` → 400 を確認。

## D4: エラー写像は既存 statusOf をそのまま使う（追加なし）

- 背景: design 判断 4 で「IFS が追加済みのコードで足りるはず」としていた。
- 決定/確認: `dtaqFailure` が出す NOT_FOUND/ACCESS_DENIED/ALREADY_EXISTS/CONFIG_ERROR/PROTOCOL_ERROR は
  `statusOf` に全て既存。**DTAQ 用の追加は不要**。実機 e2e で NOT_FOUND→404 を確認。
