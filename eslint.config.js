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
      ]
    }
  }
);
