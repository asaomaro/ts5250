# 仕様: プリンター DBCS 対応

## 設計方針
ScsDecoder に SO/SI シフト状態を持たせ、DBCS 区間は `codec.decodeDbcsPair` で全角 1 文字に畳む。
全角は等幅表示で 2 桁を占めるため、後半桁は継続（空文字列）にして `lines[r].join("")` の桁を保つ。
DBCS モードのバイトは制御コード値と衝突しうるので、制御 switch より前で 2 バイトずつ消費する。
端末タイプは SBCS/DBCS とも IBM-3812-1（別型番不要・実機確認済み）。CCSID は deviceEnvFor で申告。

## インターフェース
- `new ScsDecoder(ccsid)`：ccsid が DBCS（`codec.isDbcs`）なら SO/SI を解釈。SBCS では従来どおり
  （0x0E/0x0F はデータ文字扱い＝挙動不変）。

## 受け入れ基準との対応
- DBCS 受信・デコード・桁揃え → ScsDecoder＋golden(`scs-print-dbcs.bin`)＋合成往復テスト。
- 実機 end-to-end → `verify-printer-dbcs.mjs`。
