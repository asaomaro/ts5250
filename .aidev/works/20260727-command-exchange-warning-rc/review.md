# レビュー記録

## ラウンド 1

受領差分（他環境での修正）の取り込み。core 2 ファイル＋テスト 3 件。

### 要件適合・正確性

- **原典を直読して裏を取った**（AGENTS.md「原典を先に確認する」）。
  `archived/jtopenlite/com/ibm/jtopenlite/command/CommandConnection.java:166-178` に
  `// We ignore the same return codes that JTOPEN ignores` とあり、
  0x0100 / 0x0104 / 0x0105 / 0x0106 / 0x0107 / 0x0108 の **6 件すべてが受領差分と一致**。
  受領差分は推測ではなく原典に基づくものだと確認できた
- 修正前に落ちるテストを書き、判定を戻して**落ちることを確認**した
- 未知の戻りコード（0x1234）は従来どおり例外＝安全側は変わっていない
- **実機で実機確認**: `rc=0`（英語 NLV あり）で警告は出ず、コマンド実行が従来どおり成功。
  この環境で再現しなかった理由も裏づけられた

### 指摘

- [nit] 受領差分の元コメントは「`commandExchangeAttributes` 参照」だが、
  実際に無視しているのは `getConnection()` 内（`commandExchangeAttributes` は
  例外メッセージのラベル）。コメントを実際の位置に合わせた。／ **修正済**

### 再検証

- クリーンビルド ／ lint：成功
- core 815 件（＋3）／ 全 workspace 2,399 passed / 4 failed（既知の環境要因）
- 実機でコマンドサーバー接続・CL 実行が成功

**判定: must 0 / should 0 / nit 1（修正済）。review 通過。**
