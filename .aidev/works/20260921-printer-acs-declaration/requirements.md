# 要件: プリンターセッションの申告・ジョブの終わり・CLEAR への応答を ACS と同じにする

## 背景 / 課題
- 日本語の帳票（IGC 属性）をプリンターセッション（書き出し経路＝push）で受けると、ホストが `CPA3303` で止まり、
  待ち行列の先頭で詰まって後続もすべて止まる。README と `docs/HOST-PRINT-TRANSFORM.md` は「ホスト側の制約で変えられない」と
  書き、取得経路（pull）での救出に頼っていた。
- ACS は DBCS で HPT なしのとき端末タイプを `IBM-5553-B01` にし、変数も当 PJ と違う組を送る（`DS5250P.initializeTelnet`・
  `NVT5250.userVarPRTDB`）。実機で並べたところ、**ACS の申告なら装置が 5553 として作られ、日本語の帳票が最後まで届いた**
  （当 PJ の申告では装置が 3812 にされ CPA3303。research F1〜F3）。
- あわせて、ACS と違う受け方が 2 つある: ジョブの終わりを**レコード長 17** で見ている（5553 では 16 バイトで届いたので
  帳票が確定しない）、CLEAR（opcode 2）に**応答しない**。印刷完了の応答の予約 2 バイトも ACS と違う。

## 目的 / ゴール
- DBCS のプリンターセッションで、日本語の帳票が ACS と同じく書き出し経路でそのまま届き、帳票として表示・PDF にできる状態。
- ホストとのやり取り（申告・応答）が ACS と同じバイトになっている状態。

## ユーザーストーリー
- US1: 日本語の帳票を扱う利用者として、プリンターセッションで帳票をそのまま受けたい。なぜなら、今は CPA3303 で待ち行列ごと
  止まり、救出を待つか HPT（PCL になり表示できない）に切り替えるしかないから。（受け入れ: AC1, AC2）
- US2: 運用者として、印刷の取り消し（CLEAR）でホストを待たせたくない。なぜなら ACS は応答して次へ進むから。（受け入れ: AC3）

## スコープ
### 対象
- 端末タイプと NEW-ENVIRON の変数（DBCS／SBCS × HPT あり／なし の 4 通り）を ACS の組にする。
- ジョブの終わりの判定を ACS の規則（フラグ 0x08 ＋ 本体が空か 0x00 だけ）にする。
- CLEAR に CLEAR_PROCESSED を返し、受けかけのジョブを閉じる。印刷完了の応答を ACS のバイト列にする。
- README・`docs/HOST-PRINT-TRANSFORM.md` の誤った記述の訂正。
### 対象外
- 印刷先（PDF・自動印刷）の失敗時に応答を保留する（ACS `processPrinterError`）——設計が大きいので別の work にする（台帳に残す）。
- 自動サインオンの変数（USER / IBMRSEED / IBMSUBSPW）の形——台帳の「【まとめ】telnet」で扱う。
- 装置名を指定しないときの `DEVNAME`（ACS は空の値を送る。当 PJ は送らない）。

## 非機能要件 / 制約
- 表示セッションの申告は変えない。

## 完了条件 (受け入れ基準)
- [ ] AC1: 申告が ACS と同じになる——DBCS・HPT なしは `IBM-5553-B01` と DEVNAME / IBMMSGQNAME=QSYSOPR / IBMMSGQLIB=*LIBL /
  IBMFORMFEED / IBMIGCFEAT=2424J0 / IBMTRANSFORM=0、SBCS・HPT なしは `IBM-3812-1` と DEVNAME / IBMMSGQNAME / IBMMSGQLIB /
  IBMFONT=11 / IBMFORMFEED / IBMBUFFERSIZE=768 / IBMTRANSFORM=0、HPT は ACS の `userVarPRT?BHPT` の組。KBDTYPE / CODEPAGE /
  CHARSET / IBMSENDCONFREC は送らない。
- [ ] AC2: 実機（日本語機）で、DBCS のプリンターセッションが IGC 属性の帳票を受けて帳票（日本語のページ）として確定する。
- [ ] AC3: ジョブの終わりを ACS の規則で判定し（16 バイトでも 17 バイトでも）、CLEAR には CLEAR_PROCESSED を返して受けかけのジョブを閉じる。
  応答は ACS のバイト列（予約 0x0102）で、ACS と同じく最後に設定された応答を以後のレコードにも返す。
- [ ] AC4: 各判定を外すとテストが落ちる（`verify-by-mutation`）。
