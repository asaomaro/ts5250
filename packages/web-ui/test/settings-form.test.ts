import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import SettingsForm from "../src/components/SettingsForm.vue";

/**
 * 設定フォームのキーボード操作・フォーカス管理（requirements AC-I2〜AC-I4）。
 * `InfoPopover.vue`にはフォーカストラップが無いため、ここで自前実装した分を検証する。
 *
 * `app`は必須propなので、emulator専用フィールド（端末の種類/画面サイズ/装置名）を
 * 意図的に含めたくない汎用テストは`"sql"`を渡す（フィールド数が増えず、既存の
 * 期待値をそのまま保てる。`20260924-vscode-extension` D14）。
 */
beforeEach(() => document.body.replaceChildren());

describe("SettingsForm", () => {
  it("開いた直後、最初の入力欄（ホスト）へフォーカスする", async () => {
    const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(w.get("#sf-host").element);
  });

  it("最後の要素でTabを押すと最初の要素へ回る（フォーカストラップ）", async () => {
    const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
    await nextTick();
    const save = w.get('button[type="submit"]').element as HTMLButtonElement;
    save.focus();
    await w.get(".settings-form").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(w.get("#sf-host").element);
  });

  it("最初の要素でShift+Tabを押すと最後の要素へ回る", async () => {
    const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
    await nextTick();
    const host = w.get("#sf-host").element as HTMLInputElement;
    host.focus();
    await w.get(".settings-form").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(w.get('button[type="submit"]').element);
  });

  it("Escapeでcancelを発火する", async () => {
    const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
    await w.get(".settings-form").trigger("keydown", { key: "Escape" });
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("バックドロップのクリックでもcancelを発火する", async () => {
    const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
    await w.get(".backdrop").trigger("click");
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("入力して保存すると、入力値でsaveを発火する（空欄は省く）", async () => {
    const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
    await w.get("#sf-host").setValue("AS400");
    await w.get("#sf-port").setValue("992");
    await w.get("#sf-user").setValue("MYUSER");
    await w.get(".settings-form").trigger("submit");
    const saved = w.emitted("save")?.[0]?.[0];
    expect(saved).toEqual({ host: "AS400", port: 992, tls: true, user: "MYUSER" });
  });

  it("初期値（initial）があればフィールドへ反映する", () => {
    const w = mount(SettingsForm, {
      props: { app: "sql", initial: { host: "H", port: 23, tls: false, user: "U" } },
      attachTo: document.body
    });
    expect((w.get("#sf-host").element as HTMLInputElement).value).toBe("H");
    expect((w.get("#sf-port").element as HTMLInputElement).value).toBe("23");
    expect((w.get("#sf-tls").element as HTMLInputElement).checked).toBe(false);
    expect((w.get("#sf-user").element as HTMLInputElement).value).toBe("U");
  });

  /**
   * **ホストコードページ**（CCSID + 930のKatakana/Katakana Extended）は自由入力ではなく
   * ACSの一覧に倣った1本の`<select>`から選ぶ（`hostCodePages.ts`。利用者の要望「CCSIDは
   * ドロップダウンから選択させる」。`20260924-vscode-extension` D14）。
   */
  describe("ホストコードページ（CCSID）", () => {
    it("既定は「未指定」で、保存してもccsidを省く", async () => {
      const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
      await w.get("#sf-host").setValue("AS400");
      await w.get(".settings-form").trigger("submit");
      const saved = w.emitted("save")?.[0]?.[0] as Record<string, unknown>;
      expect(saved.ccsid).toBeUndefined();
      expect(saved.katakanaVariant).toBeUndefined();
    });

    it("930（拡張カタカナ）を選ぶと、ccsidとkatakanaVariantの両方が乗る", async () => {
      const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
      await w.get("#sf-host").setValue("AS400");
      await w.get("#sf-ccsid").setValue("930-katakana-ex");
      await w.get(".settings-form").trigger("submit");
      const saved = w.emitted("save")?.[0]?.[0];
      expect(saved).toMatchObject({ ccsid: 930, katakanaVariant: "katakana-ex" });
    });

    it("939（katakanaVariantを持たない選択肢）を選ぶと、ccsidだけが乗る", async () => {
      const w = mount(SettingsForm, { props: { app: "sql" }, attachTo: document.body });
      await w.get("#sf-host").setValue("AS400");
      await w.get("#sf-ccsid").setValue("939");
      await w.get(".settings-form").trigger("submit");
      const saved = w.emitted("save")?.[0]?.[0] as Record<string, unknown>;
      expect(saved.ccsid).toBe(939);
      expect(saved.katakanaVariant).toBeUndefined();
    });

    it("initialのccsid/katakanaVariantから、選択済みの選択肢を復元する", () => {
      const w = mount(SettingsForm, {
        props: { app: "sql", initial: { host: "H", ccsid: 930, katakanaVariant: "katakana" } },
        attachTo: document.body
      });
      expect((w.get("#sf-ccsid").element as HTMLSelectElement).value).toBe("930-katakana");
    });

    /**
     * 5026/5035等、ACSの一覧に無いCCSID（`hostCodePages.ts`のdocコメント参照）を
     * 手編集で持つ`.ts5250`ファイルを開いた場合。ドロップダウンには対応する選択肢が無く
     * 「未指定（既定）」表示になるが、**その欄を一切触らず他の項目だけ変えて保存しても、
     * 元のccsidを消してはいけない**（黙って設定を壊す事故になる）
     */
    it("一覧に無いCCSID（5026）は「未指定」表示になるが、他の項目だけ変えて保存しても消えない", async () => {
      const w = mount(SettingsForm, {
        props: { app: "sql", initial: { host: "H", ccsid: 5026 } },
        attachTo: document.body
      });
      expect((w.get("#sf-ccsid").element as HTMLSelectElement).value).toBe("unset");
      await w.get("#sf-port").setValue("992");
      await w.get(".settings-form").trigger("submit");
      const saved = w.emitted("save")?.[0]?.[0];
      expect(saved).toMatchObject({ ccsid: 5026, port: 992 });
    });
  });

  /**
   * **`terminal`/`screenSize`/`deviceName`はemulator専用**（`embed-protocol.ts`の
   * `ConnectPayload`のドキュメント注記どおり）。printer(スプール表示)/sql/ifsでは
   * フォーム自体に出さない——出しても保存先（`.ts5250`）には意味を持たないフィールドで、
   * 出すこと自体が誤解を招く
   */
  describe("emulator専用フィールドの出し分け", () => {
    it("emulatorでは端末の種類・画面サイズ・装置名を出す", () => {
      const w = mount(SettingsForm, { props: { app: "emulator" }, attachTo: document.body });
      expect(w.find("#sf-terminal").exists()).toBe(true);
      expect(w.find("#sf-screensize").exists()).toBe(true);
      expect(w.find("#sf-device").exists()).toBe(true);
    });

    it.each(["printer", "sql", "ifs"] as const)("%sでは出さない", (app) => {
      const w = mount(SettingsForm, { props: { app }, attachTo: document.body });
      expect(w.find("#sf-terminal").exists()).toBe(false);
      expect(w.find("#sf-screensize").exists()).toBe(false);
      expect(w.find("#sf-device").exists()).toBe(false);
    });

    it("emulatorで端末の種類を3270にすると、画面サイズの欄が消え、保存してもscreenSizeを省く", async () => {
      const w = mount(SettingsForm, { props: { app: "emulator" }, attachTo: document.body });
      await w.get("#sf-host").setValue("AS400");
      await w.get("#sf-terminal").setValue("3270");
      await nextTick();
      expect(w.find("#sf-screensize").exists()).toBe(false);
      await w.get(".settings-form").trigger("submit");
      const saved = w.emitted("save")?.[0]?.[0];
      expect(saved).toMatchObject({ terminal: "3270" });
      expect((saved as Record<string, unknown>).screenSize).toBeUndefined();
    });

    it("emulatorで5250のまま保存すると、terminalとscreenSizeの既定値が乗る", async () => {
      const w = mount(SettingsForm, { props: { app: "emulator" }, attachTo: document.body });
      await w.get("#sf-host").setValue("AS400");
      await w.get(".settings-form").trigger("submit");
      const saved = w.emitted("save")?.[0]?.[0];
      expect(saved).toMatchObject({ terminal: "5250", screenSize: "24x80" });
    });
  });
});
