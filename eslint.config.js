import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/core/src/codec/tables/**",
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
    // core のピュアロジック層は Node API 非依存（design: I/O は transport/ と log.ts に隔離）
    files: ["packages/core/src/**"],
    ignores: ["packages/core/src/transport/**", "packages/core/src/log.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "core のピュアロジック層では Node API を import しない（transport/・log.ts のみ許可）"
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
            "core のピュアロジック層では Buffer を使わない。Uint8Array を使う（transport/・log.ts のみ許可）"
        },
        {
          name: "process",
          message: "core のピュアロジック層では process を参照しない（設定は引数で受け取る）"
        },
        { name: "__dirname", message: "core のピュアロジック層では Node 固有のグローバルを使わない" },
        { name: "__filename", message: "core のピュアロジック層では Node 固有のグローバルを使わない" },
        { name: "global", message: "core のピュアロジック層では Node 固有のグローバルを使わない" },
        { name: "require", message: "core のピュアロジック層では CommonJS の require を使わない" }
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
