import type { CommandConnection, CommandResult } from "./command-connection.js";
import { buildCommand, type BuildOptions, type CommandValue } from "./command-build.js";
import { retrieveCommandTemplate, type CommandTemplate } from "./command-template.js";

/**
 * **テンプレートを覚えておく入れ物。**
 *
 * コマンド定義は実行中に変わらないので、同じコマンドを何度も引かない。
 * `CPYF` は 12KB あり、2 往復かかる——ループの中で毎回引くと目に見えて遅い。
 */
export class CommandTemplateCache {
  private readonly byKey = new Map<string, CommandTemplate>();

  async get(conn: CommandConnection, command: string, library = "*LIBL"): Promise<CommandTemplate> {
    const key = `${library.toUpperCase()}/${command.toUpperCase()}`;
    const hit = this.byKey.get(key);
    if (hit !== undefined) return hit;
    const tpl = await retrieveCommandTemplate(conn, command, { library });
    this.byKey.set(key, tpl);
    return tpl;
  }

  clear(): void {
    this.byKey.clear();
  }

  get size(): number {
    return this.byKey.size;
  }
}

export interface RunTemplateOptions extends BuildOptions {
  library?: string;
  cache?: CommandTemplateCache;
  /** 失敗をエラーにする（既定 true）。false なら結果を見て自分で判断する */
  throwOnFailure?: boolean;
}

/**
 * テンプレートを引き、値を埋め、実行する。
 *
 * ```ts
 * await runCommandTemplate(conn, "CRTLIB", { LIB: "TESTLIB", TEXT: "It's a test" });
 * // 実行されるのは CRTLIB LIB(TESTLIB) TEXT('It''s a test')
 * ```
 */
export async function runCommandTemplate(
  conn: CommandConnection,
  command: string,
  values: Readonly<Record<string, CommandValue | undefined>>,
  opts: RunTemplateOptions = {}
): Promise<CommandResult & { command: string }> {
  const cache = opts.cache ?? new CommandTemplateCache();
  const tpl = await cache.get(conn, command, opts.library ?? "*LIBL");
  const text = buildCommand(tpl, values, opts.allowUnknown !== undefined ? { allowUnknown: opts.allowUnknown } : {});
  const result =
    opts.throwOnFailure === false ? await conn.run(text) : await conn.runOrThrow(text);
  return { ...result, command: text };
}
