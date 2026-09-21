# 決定記録

## D1: 数字の判定は Unicode の数字（`\p{Nd}`）

- jt400 は `Character.isDigit`（Unicode の Nd）。全角の数字で始まるパスワードは `Q` を付けたうえで CCSID 37 に無いので送れない（jt400 も
  `SignonConverter` で例外になることを Java で確かめた）。telnet 側（ACS `PasswordSubstitute`）の `[0-9]` はそのまま（別の原典）。

## D2: レベル 4 と数字始まりのパスワードは実機で確かめていない

- 手元の実機はレベル 0 と 3 で、利用者のパスワードは英字で始まる。ACS に同梱の jt400 を Java から呼んだ出力との一致までで、実機は**未確認**。
  レベル 0・3 の実機では従来どおり認証できることを確かめた（回帰）。

## D3: DDM も jt400 と同じ置換値・SECMEC にし、レベル 0/1 を断るのをやめる（マイルストーン 8 の独立点検）

- 証拠: jt400 `AS400ImplRemote` の DDM の経路（`service == 5`）は `getPassword` を通り、`DDMACCSECRequestDataStream` は `passwordLevel >= 2` で SECMEC 8・それ以外 6、
  `DDMSECCHKRequestDataStream` は置換値が 20・64 バイトで 8・それ以外 6。当 PJ は常に SHA-1・SECMEC 8 で、レベル 0/1 は「DES 未対応」として断っていた（jtopenlite 由来）。
- 実機: 社内機（レベル 0）でも DDM の握手が通った。PUB400（レベル 3）も通る。

## D4: 属性交換のデータストリーム・レベルとシード交換のクライアント属性を jt400 の値にする

- 属性交換（0x7003）は 10、シード交換（0x7001）は 3（`SignonExchangeAttributeReq` / `AS400XChgRandSeedDS`）。ビットの意味とレベル 4 で効くかは**未確認**。
  レベル 0・3 の実機でサインオン・DB・IFS・コマンド・DDM が通ることを確かめた（応答の読み方は変わらない）。
