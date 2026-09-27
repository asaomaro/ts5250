# 要件: ホストのエラーの保留の残り（SysReq の行の間の保留・保留の間の CC2・READ の印）

## 背景 / 課題
`.aidev/backlog/acs-parity.md` の「ホストのエラーの保留の残り」: SysReq の行を出している間の保留（ACS は同じ仕組みで止める）・同じレコードの WTD より前の CC2 が ACS では流すまで遅れる・
`20260927-wec-only-unlock` の残り（CANCEL INVITE・WSF・オペコード・RESTORE での `pending_read`、溜めた AID の間の施錠、Attn / SysReq で溜めを捨てるか、早い Enter の後の F3 の欄）。

## 目的 / ゴール
SysReq の行の間のホストの出力・保留の間の CC2・READ が出ているかの印が、実機の ACS と同じになっている状態。確かめられないものは理由とともに閉じる。

## ユーザーストーリー
- US1: 5250 端末の利用者として、SysReq の行を開いている間にホストが画面を書き換えても、ACS と同じく行を閉じるまで待ってほしい。なぜなら行を打っている最中に画面が変わると、何に対してシステム要求を出すのかが分からなくなるから。（受け入れ: AC1, AC2）

## スコープ
### 対象
- core（SysReq の行の保留・保留の間の CC2・CANCEL INVITE と RESTORE の印）、server（ws の `sysreq-line`）、web-ui（行の開閉を知らせる）
### 対象外（理由を decisions に書いて閉じる）
- オペコード（INVITE・PUT/GET）だけで READ が出たとする ACS の扱い・WSF で下ろす扱い（実機のトレースに READ の無い PUT/GET・READ の前の WSF が無い）
- 溜めた AID の間も ACS は施錠しない（当 PJ は `sendAid` の待ちを保つための決め）・Attn / SysReq で溜めを捨てるか・早い Enter の後の F3 の欄（測り方が無い／原典で説明できない）

## 完了条件 (受け入れ基準)
- [ ] AC1: 実機の ACS のコアで、SysReq の行の間に届いた WTD が行を閉じるまで出ないことを測り、当 PJ も同じにする（単体・実機）
- [ ] AC2: 保留が始まったレコードの前の WTD の CC2（メッセージ待ち）が、抜けて流し終えてから効く（ACS の実測・単体・実機）
- [ ] AC3: CANCEL INVITE で READ の印を下ろし、RESTORE SCREEN で戻す（原典。単体）
- [ ] AC4: 片付け
