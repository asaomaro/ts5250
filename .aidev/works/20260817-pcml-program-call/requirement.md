# 要件: プログラム界面を「記述」から駆動する（PCML 相当）

## 背景 / 課題

`20260804-program-call` で**変換の層**は開いた——`ProgramArg`（char / packed / zoned /
bin / bytes / null）で、EBCDIC も詰め 10 進も呼ぶ側が組まずに済む。

だが jt400 の PCML と突き合わせると、**上半分が丸ごと無い**。

PCML は 2 つのものの合わせ技である。

1. **型体系**（値 ↔ バイト列の変換）── うちにも**ある**
2. **外部の宣言文書**（`.pcml` を 1 度書けば、以後は名前で触れる）── うちには**無い**

`jtopen` の原典を読んで確かめた事実:

| PCML の道具立て | 出典 | ts5250 |
|---|---|---|
| `usage` in/out/inputoutput | `PcmlData.java` `DATAATTRIBUTES` | ✓ `dir` |
| `passby` value/reference | 同上（Ver.2.0） | ✓ `pass`（サービスプログラム） |
| `type` char / byte | `PcmlData.java:1773-` | ✓ `char` / `bytes` |
| `type` packed / zoned | 同上 | ✓ `packed` / `zoned` |
| `type` int（`precision` 15/16・31/32・63/64） | `PcmlData.java:2253` | △ `bin` **符号なしが無い** |
| `type` float | `PcmlData.java:1781` | ✗ |
| **`type` struct（入れ子）** | `PcmlStruct.java` | ✗ `bytes` に base64 で手詰め |
| **`count`（整数、または他項目名＝可変長配列）** | `PcmlData.java:1460-1483` | ✗ |
| **名前でアクセス** `setValue("PGM.parm")` | `ProgramCallDocument.java` | ✗ **位置だけ** |
| `init` / `outputsize` / `offset` / `offsetfrom` | `DATAATTRIBUTES` | ✗ |
| `ccsid`（項目ごと） | 同上 | △ **接続ぜんたいで 1 つ** |

**効くのは太字の 3 行**。RPG の実務は「構造体を 1 個渡す」「件数つきの配列を返す」が
ほとんどで、そこが `bytes` ＋ base64 の手詰めになる。手詰めということは、
**桁ずれが型で止まらず、静かに誤った値が入る**ということ。

### ホストに問い合わせる口は無い

`ProgramCallDocument` の構築子を全て読んだ（`ProgramCallDocument.java:142,168,198,224,255,287,309,334`）。
**ホストへ問い合わせる経路は 1 つも無い**——`docName` はクラスパス上の資源か `InputStream`。
CL における `QCDRCMDD`（`20260817-cl-command-template` で使った定義取得 API）に
当たるものが RPG には無い。

PCML の出どころは**コンパイラ**である（`PGMINFO(*PCML) INFOSTMF('/…')`）。
つまり取りに行く先は**ホストの API ではなく IFS**。IFS の読み出しは既にある。

## 目的 / ゴール

**`.pcml` を読んで、名前でプログラムを呼べる。**
構造体と配列が**型で通り**、手詰めが要らない。

## スコープ

### 対象

- **`.pcml` の解析**（`program` / `struct` / `data` と必要な属性）
- **構造体**（入れ子を含む）と**配列**（`count` が整数／他項目名）
- **名前でのアクセス**（`"PGM.parm"` / `"PGM.st.field"` / 配列は添字）
- **`.pcml` の取得**: IFS から読む／文字列で渡す
- REST の口と web-ui の導線（`pgm:` ペインを記述から組み立てる）
- **実機で `PGMINFO(*PCML)` を測る**（本当に吐くのか、中身は何か）

### 対象外

- **XPCML**（PCML の XML Schema 版。`XPCMLHelper.java`）
- **RFML**（レコード様式版。`RfmlDocument.java`）
- `type` date / time / timestamp（`dateformat` 等の書式属性が別の沼）
- `minvrm` / `maxvrm` / `bidistringtype` / `chartype`
- `.pcml` の**生成**（原型定義から書き出す向き）

## 機能要件

- `.pcml` を解析して**プログラム界面**を得る。壊れた記述は**位置つきで拒否**する
- `type` は **char / int / packed / zoned / float / byte / struct** を通す
  - `int` は **`precision` で符号なしも通す**（15/16・31/32・63/64）
- `count` を通す。**他項目名を書いた可変長配列**も通す
- **名前で値を入れ、名前で読む**
- `usage` / `length` / `precision` / `ccsid` / `init` / `passby` を尊重する
- IFS 上の `.pcml` を指定して呼べる
- 既存の**位置指定の呼び出しは壊さない**（`ProgramArg` はそのまま残す）

## 非機能要件 / 制約

- 解析と変換は**純粋な関数**（Node API に依存しない）——スクリプトからも使える
- **既存 4,000 件超を壊さない**
- **実機で確かめる**（RPG を `PGMINFO(*PCML)` 付きで作り、往復させる）
- 記述の**取り違えを黙って通さない**——長さ・桁・件数が合わなければ止める

## 完了条件 (受け入れ基準)

- [ ] 実機で `PGMINFO(*PCML)` を吐かせ、**中身を記録**した
- [ ] その `.pcml` を IFS から読んで**解析**できる
- [ ] **構造体**を渡して受け取れる（base64 の手詰め無し）
- [ ] **配列**を受け取れる（`count` が他項目名の可変長を含む）
- [ ] **名前**で値を入れ、名前で読める
- [ ] REST から同じことができる
- [ ] web-ui から `.pcml` を選んで呼べる
- [ ] **実機で往復を確認**（構造体と配列を含む RPG プログラム）

## 未確定事項 / 確認したいこと

- **`PGMINFO(*PCML)` が実機で通るか**。RPG IV（`CRTBNDRPG`）で確かめる。
  通らなければ `.pcml` を手書きする道に切り替える（それでも上半分の値打ちは残る）
- 実機に RPG コンパイラがあるか（無ければ COBOL の `PGMINFO` を見る）
- `init` の適用範囲（入力を省いたときだけか、常にか）を原典で確定する
