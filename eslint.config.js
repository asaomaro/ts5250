import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/ebcdic/src/tables/**",
      "packages/web-ui/**",
      // Electron ランタイム（CommonJS）は TS eslint 対象外
      "electron/**",
      // AI 開発ワークフローの作業状態・研究成果物（プローブ script 等）は lint 対象外
      ".aidev/**"
    ]
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // stdio MCP の stdout 汚染防止（spec D9）。ログは pino/stderr ラッパのみ
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ]
    }
  },
  {
    // core のピュアロジック層は Node API 非依存（design: I/O は transport/ に隔離）。
    //
    // **ebcdic / scs / base / hostserver にも同じガードを掛ける。** 何かを core の外へ
    // 切り出すたび、`packages/core/src/**` だけの glob ではガードが静かに外れる——そして
    // 「依存ゼロ・ブラウザで動く」はこれらのパッケージの売りそのものなので、
    // 外れたことに気づけないまま Node 依存が入るのが最悪の結末になる。
    // 実際、hostserver を切り出したとき（`20260801-library-extraction-hostserver`）、
    // 移設前の `hostserver/**` はこの glob の下で守られていた（`node:*` の import は 0 件）。
    // ここへ足さなければ、その保護だけが黙って消えていた。
    //
    // **ebcdic には型の防壁が無い**——`TextDecoder` / `TextEncoder` の型を得るために
    // `types: ["node"]` が要り、その副作用で Node API も書けてしまう。だから ebcdic に
    // 限っては禁止をここでしか担保できない（core・hostserver も transport/ のため同様）。
    // base と scs は `types: []` なので型検査でも弾かれるが、二重に掛けておく。
    //
    // かつて除外していた `packages/core/src/log.ts` は **`@ts5250/base` へ移り、除外も要らなくなった**
    // ——pino を直接 import していた頃の名残で、`setLogSink` の注入式にした今は Node API を使わない。
    files: [
      "packages/base/src/**",
      "packages/tn5250/src/**",
      "packages/tn3270/src/**",
      "packages/ebcdic/src/**",
      "packages/hostserver/src/**",
      "packages/scs/src/**"
    ],
    ignores: [
      "packages/tn5250/src/transport/**",
      "packages/tn3270/src/transport/**",
      "packages/hostserver/src/transport/**"
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "ピュアロジック層（core/ebcdic/scs）では Node API を import しない（core の transport/・log.ts のみ許可）"
            }
          ]
        }
      ],
      // import だけを塞いでも **グローバル参照という抜け道**が残る。
      // `Buffer.from()` は import 不要で書けてしまい、no-restricted-imports では検出できない。
      // この穴は 2 回の retro（acs-data-transfer / hostserver-sql）で指摘されながら
      // 2 回とも未適用のまま、手作業と review で防いでいた＝仕組みで防げていなかった。
      "no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "ピュアロジック層（core/ebcdic/scs）では Buffer を使わない。Uint8Array を使う（core の transport/・log.ts のみ許可）"
        },
        {
          name: "process",
          message: "ピュアロジック層（core/ebcdic/scs）では process を参照しない（設定は引数で受け取る）"
        },
        { name: "__dirname", message: "ピュアロジック層（core/ebcdic/scs）では Node 固有のグローバルを使わない" },
        { name: "__filename", message: "ピュアロジック層（core/ebcdic/scs）では Node 固有のグローバルを使わない" },
        { name: "global", message: "ピュアロジック層（core/ebcdic/scs）では Node 固有のグローバルを使わない" },
        { name: "require", message: "ピュアロジック層（core/ebcdic/scs）では CommonJS の require を使わない" }
        // **タイマー（setTimeout 等）は禁止しない。**
        // 元の retro は「Buffer / process / setTimeout 等の Node グローバル」と書いていたが、
        // setTimeout / setInterval は **ブラウザにも標準である Web API** で Node 固有ではない。
        // このルールの目的は「ブラウザで動かない依存を防ぐ」ことなので、
        // 移植性のあるタイマーを塞ぐのは目的に合わない（実際 session/ の
        // ネゴシエーションのタイムアウトという正当な用途で 11 箇所使われている）。
      ]
    }
  }
);
