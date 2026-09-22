# 調査: ACS の装置名

## 判明した事実
- F1（原典）: `NVT5250` は DEVNAME を書くたびに `AutoDeviceName5250.getAutoDeviceName` を通し、`toUpperCase`（`İ` は `I`）して送る。
  成功の起動応答（I90x）で `resetCollisionAvoidanceID`（`DS5250.processStartUpConfirmation`）。`=` の開始番号の既定は 0（`SessionConfig.getAvoidDuplicateNamesStartingIndex`、0〜9）。
- F2（原典）: 記号 `%`（表示 S・プリンター P）、`*`（セッション名の先頭 2 文字。1 文字の英小文字は頭に 0。無ければ `A`）、`=`（36 進。1 つなら開始番号から 35 まで、
  2 つ以上なら乱数（×1295・×46655）の位置から、先頭の `=` が最も速く回る。最上位があふれると、乱数の位置からなら 35 を出して 1 へ回り、そうでなければ記号のまま返す）、
  `+`（`&COMPN` / `&USERN` が長すぎるとき左を残す）、`&COMPN`（Windows は `CLIENTNAME`、無ければ機械名の最初の `.` まで）・`&USERN`（Java の `user.name`）。
  `&` を含むと記号以外の文字を足さない（`if (!bl)`）。残す長さは 10 − パターン上の位置 − 残りの記号の数（`+` があれば +1）。番号を使わなければ内部の番号を −1 にする。
- F3（実機・ACS のコア・タップ・PUB400）: `tsLow1x` → `TSLOW1X`、`W%*` → `WSA`、`T%*+&USERN` → `SA`＋利用者名の左 7 文字、`T%*&USERN` → `SA`＋右 7 文字、
  `U&COMPN` → 機械名の右 9 文字（`U` は送られない）。すべて I902。
- F4（実機・同）: `TSC0` を当 PJ のコアで掴んだまま `TSC=` → `TSC0` → ホストが同じ接続で NEW-ENVIRON SEND を送り直し、起動応答 8902 → `TSC1` → I902。
- F5（実機・同）: `TSD0` を掴んだまま `TSD0` → 8902 → 同じ名前を送り直す → そのまま繋がらない（`started=false`）。社内機でも 8902 の後に SEND が 2 回来た（前の実測）。
- F6（当 PJ）: `telnet.ts` は `deviceName` をそのまま送る。`SessionManager.retryWithNextDeviceName` はどの失敗でも繋ぎ直して 5 回まで試す。
