# 決定記録

## D1: 溜めた AID を捨てる時機は ACS の原典と実測に合わせる
- WEC（`initKeyboard` の `pending_aid = 0`。実測 F4）・CC1 の施錠（`processWCC1`）・繋ぎ直しで捨てる。WEC は READ が出ている印も下ろす（`pending_read = 0`）。同じレコードの後ろの READ で立て直す。

## D2: ACS と違うまま残すもの（未確認・未対応）
- Attn / SysReq で溜めた AID を捨てる——ACS がどうするかは未確認（Attn の窓の READ に古い Enter を送らないための当 PJ の決め。独立点検の指摘）
- ACS は CANCEL INVITE・WSF でも `pending_read` を下ろし、オペコード（INVITE・PUT/GET）だけで立て、RESTORE で `pending_read`・`pending_aid` を戻し、0x42 の READ はエラーを抜けたときに戻す。当 PJ はどれもしない
- ACS は溜めた AID の間も施錠しない（打鍵を続けられる。実測 F2 の inhibit=0）。当 PJ は `sendAid` の待ちを保つため施錠する
- F4 の「早い Enter の後の F3 に欄が付かない」は未確認
- AID のカーソルの 2 バイト（F3。台帳のキー編集の細部 (f)）
