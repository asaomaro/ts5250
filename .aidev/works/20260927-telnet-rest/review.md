# レビュー記録

## ラウンド 1

- [should][conv:verify-by-mutation] `packages/tn5250/src/telnet/telnet.ts` 自動サインオンでないとき IBMRSEED のシード 8 バイトをそのまま返し、0x00〜0x03 が IS の中で偽の項目になる（ACS は最初の止まるバイトで返しを止める）/ 対応: 名前の読み取りの終わりまでを返し、制御バイトを含むシードのテストを足した
- [nit][conv:-] シードの無い `USERVAR IBMRSEED` なら後ろの項目を飛ばす / 対応: 未確認として注記
- [nit][conv:-] JSDoc の答えの並びが自動サインオンのときだけ正しい / 対応: 両方を書いた
- [nit][conv:-] `answerEnvSend` を export しているが直に使われていない / 対応: 対応しない（純関数の入口として残す。単体は TelnetLayer 経由）
- [nit][conv:-] ACS は名前を前方一致で比べる / 対応: 注記した
