# 調査: ACS の起動応答の文言

## 判明した事実
- F1（原典）: `AcsOnly` は起動応答が I901・I902 以外なら `KEY_5250_CONNECTION_ERR_<コード>` を引き、無ければコードそのものを状態行に出す。
- F2（ACS の文言表。`acshod2.jar` の `com/ibm/eNetwork/msgs/hod_en` を Java で読んだ）: 2703 は "Controller description not found."、2777 は
  "Damaged device description."、8936 は "Security failure on session attempt."、8937 は "Automatic sign-on rejected."。表には 2702・2703・2777・
  8901〜8940・I904 がある（`hod_ja` も同じキー）。0004 は無い。
- F3（当 PJ）: `startup-record.ts` の英語の表は 2703・2777 を「未確認」、8936 を "Automatic sign-on failed." としていた（`20260921-startup-codes-unknown`）。
  プリンター側の表（`printer-session.ts`）は 8936 を ACS と同じ意味で別に持っていた。
- F4（当 PJ）: 開く前の失敗は `session-controller.ts` が `${code}: ${message}` の Error にしてランチャーに出す。開いたあとは `wsErrorNotice` が code の見出しを出す。
