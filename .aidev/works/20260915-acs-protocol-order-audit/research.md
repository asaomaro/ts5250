# 調査: ACS のコア実装（DS5250/PS5250）と突き合わせた5250プロトコル処理の棚卸し（第1弾）

## 調査の問い

- Q1: ACS の `DS5250.processWriteToDisplay()` のオーダー switch と、
  `wtd-applier.ts` のオーダー処理に対応漏れが無いか。
- Q2: ACS が「未知オーダー」に遭遇したときの復旧処理は、`wtd-applier.ts` の
  `default:` 節（次の ESC+既知コマンドまで読み飛ばす、破壊的な復旧処理）と
  同じ設計か、それとも異なるか。
- Q3: `ORDER.UNKNOWN_1C`（0x1C）の正体（既存コードのコメントで「正体未確認・
  要再確認」とされていた）は、ACS のソースコードから確定できるか。
- Q4: Q3 と同種の対応漏れ（表示データとして特別な文字置換を要するバイト値）が
  他にも無いか。

## 判明した事実

- F1: ACS のデコンパイル済みコア `DS5250.processWriteToDisplay()`
  （`decisions.md` D6 で `20260914-seu-page-cursor-hold` がデコンパイルした
  `acsbundle.jar` 内の `com.ibm.eNetwork.ECL.tn5250.DS5250`）のオーダー switch は
  `case 1, 2, 3, 16, 17, 18, 19, 20, 21, 29`（10進）を扱う。16進に直すと
  `0x01(SOH), 0x02(RA), 0x03(EA), 0x10(TD), 0x11(SBA), 0x12(WEA), 0x13(IC),
  0x14(MC), 0x15(WDSF), 0x1D(SF)` となり、`packages/tn5250/src/protocol/
  constants.ts` の `ORDER` 定数（`SOH, RA, EA, TD, SBA, WEA, IC, MC, WDSF, SF`）と
  **完全に1:1で一致する**。`wtd-applier.ts` のオーダー switch にもこの10種類
  全てに対応する `case` があり（WEA は `20260914-dspfmt-field-underline-instability`
  で追加済み）、**Q1 の答えは「対応漏れ無し」**。
  確認場所: デコンパイル済みソース（スクラッチパッド
  `acs/decompiled-DS5250.java`、`processWriteToDisplay()` メソッド内の switch 文、
  1616〜2010行付近）、`packages/tn5250/src/protocol/wtd-applier.ts` の
  オーダー switch 全体（`applyWtd()` 関数）。
- F2: ACS の switch に一致しなかったバイト値（`default` 相当）は、**「未知オーダー」
  として捨てるのではなく、表示データとして扱われる**。具体的には、switch 文の
  直後に次のようなループがある（デコンパイル済みソース 2011〜2019行、
  `var21_13` は表示データを溜めるバッファ）:
  ```java
  while (var9_12 < var3_3 && var1_1[var9_12] != 4
      && var1_1[var9_12] != 1 && var1_1[var9_12] != 2 && var1_1[var9_12] != 3
      && var1_1[var9_12] != 18 && var1_1[var9_12] != 16 && var1_1[var9_12] != 17
      && var1_1[var9_12] != 19 && var1_1[var9_12] != 20 && var1_1[var9_12] != 21
      && var1_1[var9_12] != 29) {
      var21_13[var5_15++] = var1_1[var9_12++];
  }
  if (this.ps.writeString(var21_13, var5_15) != 1) continue;
  ```
  除外リストは ESC(4) と F1 の10オーダーのみ——**Q2 の答えは「ACS は未知オーダーを
  破壊的に捨てず、表示データとして書き込む」**。`wtd-applier.ts` の `default:` 節
  （次の ESC+既知コマンドまで読み飛ばす）とは設計が異なる。
- F3: `writeString()` → `addChar()`（`PS5250`）の文字変換処理に、次の特殊な
  置換がある（デコンパイル済みソース 2698行）:
  ```java
  this.TextPlane[n + n3] = sArray[n3] == 28 ? 42
      : (sArray[n3] == 30 ? 59 : (char)this.codepage.sb2uni((short)(sArray[n3] & 0xFF)));
  ```
  **バイト値 28（0x1C）は文字コード 42（`*`）へ、バイト値 30（0x1E）は文字コード
  59（`;`）へ置換して表示する**。それ以外のバイト値は通常のコードページ変換
  （`sb2uni`）を経る。**Q3・Q4 の答え**: 0x1C はこの置換ロジックの一部であり、
  「未知オーダー」ではなく「表示データとして書き込まれる際、コードページ変換の
  代わりに固定の文字へ置き換えられる特殊なバイト値」だった。**同種の置換対象が
  もう1つ（0x1E→`;`）存在する**。この置換は `sArray[n3]==28` /`==30` の2値限定で、
  他のバイト値には及ばない。
- F4: `packages/tn5250/src/protocol/wtd-applier.ts` は現在、0x1C を
  `ORDER.UNKNOWN_1C`（0x1C = 28）として main loop のオーダー switch 内に
  専用 `case` を持ち、`buf.setChar(addr++, "*")` として扱っている
  （確認場所: `wtd-applier.ts` の `case ORDER.UNKNOWN_1C:` 節）。
  **0x1E（30）に対応する処理は一切無い**——main loop は SO(0x0E)/SI(0x0F)/
  属性(0x20-0x3F)/DBCS対/`b>=0x40`の通常文字/NUL(0x00)/UNMAPPABLE(0x1F)を
  順に判定した後、いずれにも該当しないバイトはオーダー switch へ回るが、
  0x1E はそこにも `case` が無いため `default:`（未知オーダー扱い）に落ちる。
  **WEA と同じ構造の欠陥**——0x1E が WTD 内に現れると、それより後ろの
  同一 WTD 内の全オーダーが失われる。
  確認場所: `wtd-applier.ts` の main loop（`applyWtd()` 関数）全体。
- F5: 独立した参照実装（tn5250j `tnvt.java`）にはこの 0x1C/0x1E 文字置換に
  相当する処理が**無い**（WebFetch で該当ソースを確認、0x1C/0x1E ともに
  `default:` 節の `processAppendByteToScreen()` へ落ち、特別な置換をせずに
  通常の表示データとして扱われる）。GNU tn5250（`lib5250/codes5250.h` にも
  0x1C の定義が無いことは既存コード（`wtd-applier.ts` の `UNKNOWN_1C` 定数の
  doc コメント）に記録済み）にもこの置換は見当たらない。**この文字置換は
  ACS 固有の実装上の癖であり、公式仕様（SC30-3533）に明記された標準的な
  5250 オーダーではない可能性が高い**——ただし、この work の目的は「ACS との
  仕様整合」（`.aidev/backlog/acs-parity.md`）であり、公式仕様への準拠ではなく
  ACS の実際の挙動への追従が目的なので、ACS 固有の癖であっても再現する
  価値がある（`ORDER.UNKNOWN_1C` を既に同じ理由で実装済みという既存の判断とも
  整合する）。
- F6: 0x1E がこのリポジトリの既存の実機トレース fixture・診断スクリプトのログで
  実際に観測された記録は見当たらない（`packages/tn5250/test/fixtures/*.jsonl`
  を確認したが、hex 文字列中の "1e" 部分文字列一致は他の意味のバイト列との
  区別がつかないため確実な調査手段にならず、**未確認のまま**とする）。
  0x1C は過去に `WRKOBJPDM`/`DSPSPLF` 系のシステム標準画面で実機観測されている
  （`ORDER.UNKNOWN_1C` の既存 doc コメント）のに対し、0x1E は今回 ACS のソース
  コードの読解のみから発見したもので、実機での目撃例は無い。

## 影響範囲

- `packages/tn5250/src/protocol/wtd-applier.ts`: main loop に 0x1E 用の分岐を
  追加する。既存の `ORDER.UNKNOWN_1C`（0x1C）分岐と対称的な構造にする。
- `packages/tn5250/src/protocol/constants.ts`: 0x1E 用の定数を追加するか、
  `wtd-applier.ts` 内のローカル定数にするかは design で判断する
  （`UNKNOWN_1C` は `constants.ts` の `ORDER` に定義されているが、これは
  「オーダー」という誤った位置づけの名残りでもある——F2/F3 の通り実際は
  オーダーではなく表示データの文字置換なので、design でこの位置づけ自体を
  見直すかどうかも検討する）。
- `packages/tn5250/test/wtd-applier.test.ts`: 既存の「未知オーダーの後、SBA の
  パラメータを ESC と読み違えない」テスト（404〜415行）が、未知オーダーの
  例として **0x1E をそのまま使っている**。この work で 0x1E に専用の処理を
  追加すると、このテストは「未知オーダー」の例として機能しなくなる
  （0x1E がもはや未知ではなくなるため）。**このテストを別の未使用バイト値
  （例: 0x16、既存の別テストで「0x15〜0x1D の間の未使用番地」として使用実績あり）
  に差し替える必要がある**（design/tasks で対応）。

## 実現性 / リスク

- F5 の通り、この置換は ACS 固有の癖であり公式仕様書での裏付けが無い。
  ただし `ORDER.UNKNOWN_1C`（0x1C）を同じ理由（ACS の表示結果との突き合わせ）で
  既に実装済みという前例があり、0x1E も同じ扱いにすることは既存方針との
  一貫性がある。
- F6 の通り、0x1E が実機で実際に送られてくることを確認できていない
  （ACS のソースコード読解のみに基づく発見）。**修正しても、利用者が実際に
  遭遇する不具合を解消するかどうかは未検証**——ただし、WEA と同様「遭遇すれば
  確実に問題を起こす、確認済みの欠陥」を予防的に塞ぐという位置づけで価値がある
  （`20260914-dspfmt-field-underline-instability` decisions.md D1 と同じ論法）。
- F4 で見つかった `default:` 節の設計思想そのもの（ACS のように「未知バイトは
  表示データとして扱う」のではなく「次の ESC まで読み飛ばす」）を全面的に
  ACS 式へ作り替えることは、この work のスコープを大きく超える
  （既存の `default:` 節は、多数の既知の不具合修正の実績があるコードであり
  ——`research.md`（このファイル自体）が引用する `wtd-applier.ts` の既存
  コメント群を参照——安易に置き換えると別の回帰を生むリスクが高い）。
  この work では 0x1E という**具体的に確認された1件のギャップ**だけを塞ぎ、
  `default:` 節の設計そのものの見直しは対象外とする。

## design への申し送り

- 0x1E の処理を `wtd-applier.ts` の main loop に追加する（F4）。既存の
  `ORDER.UNKNOWN_1C`（0x1C）と対称的な構造にするか、共通のヘルパー関数に
  まとめるかは design で決定する。
- `ORDER.UNKNOWN_1C` の doc コメント（「正体未確認・要再確認」）を、F2・F3で
  判明した事実に基づいて更新する。
- `constants.ts` の `ORDER.UNKNOWN_1C` の位置づけ（`ORDER` オブジェクトの
  一員として定義されている）を見直すかどうかは design で判断する
  （F3 の通り実際は「オーダー」ではなく表示データの文字置換のため）。
- 既存テスト `wtd-applier.test.ts`「未知オーダーの後、SBA のパラメータを ESC と
  読み違えない」（404〜415行）の 0x1E 使用箇所を、別の未使用バイト値へ
  差し替える（影響範囲参照）。

## 実装アンカー

- A1: 0x1E 処理の追加箇所（`packages/tn5250/src/protocol/wtd-applier.ts`、
  main loop 内。既存の `ORDER.UNKNOWN_1C` 分岐——`case ORDER.UNKNOWN_1C:`——の
  近く）
- A2: `ORDER.UNKNOWN_1C` の doc コメント更新箇所（`packages/tn5250/src/protocol/
  constants.ts`、`ORDER.UNKNOWN_1C` 定数の JSDoc）
- A3: 既存テストの修正箇所（`packages/tn5250/test/wtd-applier.test.ts:404-415`）

## 実装時の注意

- 0x1C・0x1E の置換は「表示データの一部としての文字置換」であり、5250の
  「オーダー」（動作を指示するバイト列）とは性質が異なる（F2・F3）。
  `constants.ts` の `ORDER` オブジェクトに `UNKNOWN_1C` を置いている現状の設計は、
  機能的には動作するが名前・位置づけとしてはミスリーディングになりうる——
  design でリネーム・再配置を検討する余地があるが、**破壊的変更を避けるため
  既存の公開シンボルには触れない**（`constants.ts` の `ORDER` は他ファイルから
  `import { ORDER } from "./constants.js"` で参照されている前提を崩さない）。
- 0x1C の既存実装（`buf.setChar(addr++, "*")`、rawByte を渡さない）と同じ設計
  方針（rawByte を渡さないことでカタカナ表示モードの誤解釈を避ける。既存の
  `case ORDER.UNKNOWN_1C:` のコメント参照）を 0x1E にも適用する。
