# 決定記録（01-core-dtaq）

## D1: CPF メッセージ ID は固定オフセットではなく「フレーム走査」で拾う

- 背景: `dtaqFailure` は rc=0xF001（command check）を CPF ID で NOT_FOUND / ACCESS_DENIED /
  ALREADY_EXISTS に振り分ける（design 判断 4）。だが**エラー応答 0x8002 の CPF メッセージ位置は
  実機未採取**だった（research は正常応答のレイアウトを採ったが、エラー応答は採っていない）。
- 決定: `parseCpfId(frame)` はフレームを offset20 から走査し、「メッセージ接頭辞 3 文字
  （CPF/CPD/CPC/MCH）＋4 桁」の EBCDIC 並びを探す。固定オフセットを決め打ちしない。
- 理由 / 代替案: 原典が仮定する offset を埋め込む案は、IFS で踏んだ「宣言長≠実配置」の罠と同型。
  実機で採れていない位置を決め打ちすると、外したとき CPF を拾えず全部 PROTOCOL_ERROR（502）に落ちる。
  走査なら位置に依存せず、実機のレイアウトが原典と食い違っても壊れない。誤検出は接頭辞＋桁数の
  形で十分絞れる。
- 影響: server（02）は rc→HTTP ステータスを core のエラーコードから引く。CPF を拾えた分だけ
  404/403/409 に正しく落ちる。**エラー応答の CPF 位置そのものの実機採取は 02 の実機検証
  （存在しないキューを叩く等）で確認する**。正常系の rc（0xF002 キー不整合 / 0xF006 空）は
  research + 本 subtask の実機テストで確定済み。

## D2: 受信の read タイムアウトに 10 秒の猶予を足す

- 背景: `wait >= 0` のとき read タイムアウトを何秒にするか（design 判断 2 は「(wait+猶予)」）。
- 決定: 猶予 `WAIT_GRACE_SEC = 10` 秒。`wait < 0` はタイムアウト無効（0）。
- 理由: ホストが `wait` 秒ちょうどで「空（0xF006）」を返すのを、ソケットが先に切ると
  タイムアウトエラーと空の区別が付かなくなる。猶予を挟めば必ずホストの応答が先に来る。
- 影響: server の HTTP `wait` 上限（既定 60 秒）に猶予 10 秒が加わり、最長 70 秒ソケットを張る。
  02 の wait 上限を決めるとき考慮する。

## D3: 属性応答（0x8001）のレイアウトは実機＋SQL で確定

- 背景: `parseAttributesReply` の配置（maxEntryLength@22 / saveSender@26 / type@27 下位4bit /
  keyLength@28）は原典の仮定で、宣言長からは導けない。
- 決定: coding 中に実機で 3 種（FIFO/LIFO/KEYED, keyLength 0/4/7）を採取し、
  **QSYS2.DATA_QUEUE_INFO と突き合わせて一致を確認**（maxLen 333 / KEYED / keyLen 7 / senderId YES が
  自前 `attributes()` と完全一致）。原典の仮定が実機で正しかった。
- 影響: なし（原典どおりで確定）。テストは固定バイト列で回帰を止める。
