import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter } from "node:path";
import { spawn } from "node:child_process";

/**
 * 自動印刷の宛先（printer.autoPrint）の保存時チェック。
 *
 * `autoPdfDir` と違い**エラーにはせず警告に留める**。ディレクトリは「書けるか」を実際に書いて
 * 確かめられるが、プリンターは**実際に印刷して確かめるわけにいかない**（紙が出る）。さらに
 * CUPS が無い環境・確認手段が無い環境もあり、「宛先が無い」のか「確認できない」のかを
 * 区別する必要がある。確実に判定できない以上、保存を止める根拠にはならない。
 *
 * 確認するのは 2 点まで。プリンターの状態（disabled / rejecting）までは追わない。
 *   1. 印刷に使う `lp` があるか
 *   2. `lpstat -p <名前>` で宛先が引けるか
 */
export interface DestCheck {
  /** 警告文（問題なしなら undefined） */
  warn?: string;
}

/** PATH から実行可能ファイルを探す（which 相当。サブプロセスを起こさず判定する） */
async function findInPath(cmd: string): Promise<boolean> {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      /* 次の候補へ */
    }
  }
  return false;
}

/** `lpstat -p <name>` の終了コードを見る。ネットワーク宛先で待たされないよう打ち切る */
function queryDest(name: string, timeoutMs: number): Promise<"ok" | "missing" | "timeout"> {
  return new Promise((resolve) => {
    const proc = spawn("lpstat", ["-p", name], { stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill();
      resolve("timeout");
    }, timeoutMs);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve("missing"); // 起動できない＝確認不能。呼び出し側で lpstat 有無と併せて解釈する
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "ok" : "missing");
    });
  });
}

/**
 * 宛先を確認する。**保存は止めない**——戻り値の warn は UI に出す注意書き。
 * @param name 宛先プリンター名（`lp -d` に渡る値）
 */
export async function checkPrintDest(name: string, timeoutMs = 3000): Promise<DestCheck> {
  if (!(await findInPath("lp"))) {
    return { warn: `この環境では自動印刷が動きません（lp コマンドが見つかりません）。宛先: ${name}` };
  }
  if (!(await findInPath("lpstat"))) {
    return { warn: `宛先を確認できませんでした（lpstat が見つかりません）。宛先: ${name}` };
  }
  const r = await queryDest(name, timeoutMs);
  if (r === "ok") return {};
  if (r === "timeout") {
    return { warn: `宛先の確認がタイムアウトしました（${name}）。名前が正しいか確認してください。` };
  }
  return { warn: `プリンター「${name}」が見つかりません。名前が正しいか確認してください。` };
}
