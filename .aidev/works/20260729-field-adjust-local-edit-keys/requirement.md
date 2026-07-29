# 要件: FFW の ADJUST（右寄せ）とローカル編集キー（Field Exit / Erase EOF / Erase Input）

## 背景 / 課題

2026-07-28 の「EDTWRD / EDTMSK に対応できているか」調査で、**FFW の挙動ビットがほぼ未実装**、
かつ **README が対応済みと書いているローカル編集キーが 3 つとも未実装**だと分かった
（`.aidev/backlog/field-input.md`）。本作業はそのうち**結び付いた 2 件**を一体で扱う。

### 1. ADJUST（右寄せ）が一切効いていない

`packages/core/src/protocol/constants.ts` に `ADJUST_MASK 0x0007` / `ADJUST_RIGHT_ZERO 0x0005` /
`ADJUST_RIGHT_BLANK 0x0006` / `ADJUST_MANDATORY_FILL 0x0007` の定義はあるが、
**全ソースで一度も参照されていない**（`FFW.*` の参照を数えて確認済み）。

- 欄を出るときの右寄せ・ゼロ埋め／空白埋めを行わないため、**数値欄で実機と見た目も送信値も変わる**。
  backlog はこれを「この一覧では実害が最も大きい」と評価している。
- 画面スナップショット（`packages/core/src/screen/types.ts` の `Field`）は `numeric` しか公開しておらず、
  **web-ui 側から ADJUST 種別が見えない**（`buffer.ts` の `snapshot()` が FFW を落としている）。

### 2. ローカル編集キーが 3 つとも無い（README と食い違っている）

`README.md:335` は `## 🖥 Web エミュレーターの使い方` → `2. 操作` 配下の**機能一覧**に
「ローカル編集キー（Field Exit / Erase EOF / Erase Input）、キーバインドは編集可能」と書いているが、
**実装は 0 件**。ロードマップではなく現在の機能として書かれているため、実装するか README を直すかが要る。

これらは AID キーではなく**ローカル操作**（ホストへ送らず端末が完結させる）なので `LocalAction` 側の話。

- `packages/web-ui/src/composables/useKeymap.ts` の `LocalAction` は
  `home` / `end` / `tab` / `shift-tab` / 矢印 / `word-*` のみ
- `packages/web-ui/src/stores/keybindings.ts` の
  `BindingTarget = AidKey | view:${string} | macro:${string}` に**ローカル編集キーの枠が無い**
  ＝「キーバインドは編集可能」を満たすには `BindingTarget` の拡張も要る
- `packages/web-ui/src/composables/fieldEdit.ts:41` に
  「`cursor===len` は満杯で以降の入力はブロックされる（**field-exit 必要**）」というコメントがあり、
  必要性は認識されているが実行する手段が無い

### なぜ 1 と 2 を分けないか

**Field Exit の仕事の 1 つが ADJUST の適用**だから（backlog `field-input.md:85`）。実機の Field Exit は
①カーソル以降を欄末尾まで消去 ②FFW の ADJUST を適用 ③次の入力欄へ進める ④MDT を立てる、の 4 つを行う。
別々に実装すると②の配線を 2 度やることになる。

## スコープ

### やること

- **ADJUST（右寄せ）の実装**: `ADJUST_RIGHT_ZERO` / `ADJUST_RIGHT_BLANK` / `ADJUST_MANDATORY_FILL`
  - 適用の主体（core の送信時か web-ui の欄離脱時か）と適用の契機は research で原典を確認して決める
  - スナップショット `Field` に ADJUST 種別を公開する（web-ui から見えるようにする）
- **ローカル編集キー 3 種**
  - **Field Exit**: ①カーソル以降を欄末尾まで消去 ②ADJUST 適用 ③次の入力欄へ ④MDT を立てる
  - **Erase EOF**: カーソルから欄末尾まで消去（欄からは出ない＝Field Exit の①だけ）
  - **Erase Input**: 全入力欄をクリア
- **キーバインド対応**: `LocalAction` の拡張と `BindingTarget` への枠追加（「キーバインドは編集可能」を満たす）
- **README の整合**: 実装した内容に README:335 の記述を合わせる（操作方法・既定バインドの有無を明記）

### やらないこと（別 work に残す）

- **Field− / Field+**: backlog が「符号付き数値の送信表現（`SHIFT_SIGNED_NUMERIC`）と同じ設計判断になるので
  切り離さずに考えること」と明記しており、そちらは**実機で切り分けてから**判断する項目。本 work では扱わない
- **FIELD_EXIT_REQUIRED / AUTO_ENTER / MONOCASE / MANDATORY_ENTER / SHIFT の未強制分**
  （FFW の他ビット。backlog に残す）
- **DUP キー**（`DUP_ENABLE`。キー自体が未実装で、足すかどうかから判断が要る）
- EDTWRD / EDTMSK 対応（調査済み＝追加実装不要。再調査しない）

## 受け入れ基準

1. ADJUST 指定欄で、欄を出たときの値が実機の 5250 端末と一致する（右寄せ・ゼロ埋め／空白埋め）
2. Field Exit / Erase EOF / Erase Input が動作し、キー設定画面から任意のキーへ割り当てられる
3. **実機（TESTLIB）で検証する**。ADJUST 指定欄を持つ DDS フィクスチャを作り、
   入力 → 送信 → ホストが受け取った値を確認する（モックでは再現しない欠陥を拾うため。AGENTS.md「3.」）
4. **Playwright で実ブラウザ操作の確認を行う**（`scripts/verify-browser-*.mjs` と同じ方式）
5. ユニット/コンポーネントテストを追加し回帰資産化する（AGENTS.md「ビルド・テスト」）
6. README:335 の記述と実装が一致する
7. `npm run build -w @as400web/web-ui`（`vue-tsc -b`）が通る

## 制約

- **ホスト**: 実機。**ライブラリーは `TESTLIB` のみ**（他ライブラリーを作成・変更しない）
- **資格情報**: 既存基盤に載せる。`connections.json` の `実機` の `signon.passwordEnc` を
  `SecretCrypto.fromEnv()`（`.env` の `AS400_SECRET_KEY`）で復号する既存スクリプトの方式に従う。
  **平文を成果物・スクリプト・ログに書かない**（AGENTS.md セキュリティ）
- **原典確認**: 5250 の ADJUST 挙動は知識ベースで書かず、GNU tn5250 等の参照実装と実機で確認してから設計する
  （AGENTS.md「既存プロトコル実装の移植」）
- **実行モード**: autonomous（PR 作成まで自律。auto-merge はしない）

## 未確定（research で潰す）

- ADJUST の**適用契機**: Field Exit のみか、Tab / Enter による欄離脱でも適用されるか
- ADJUST の**適用主体**: 端末（web-ui）が値を書き換えるのか、送信時（core）に整形するのか
- `ADJUST_MANDATORY_FILL 0x0007` の意味（右寄せの一種か、「全桁埋めよ」という検証か）
- 実機が ADJUST 指定欄をどう送ってくるか（FFW のビットが実際に立つか）
- 既定キーバインドを付けるか（現状の既定は `ctrl+F1` / `ctrl+F3` の 2 つのみ）
