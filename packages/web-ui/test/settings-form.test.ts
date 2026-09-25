import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import SettingsForm from "../src/components/SettingsForm.vue";

/**
 * 設定フォームのキーボード操作・フォーカス管理（requirements AC-I2〜AC-I4）。
 * `InfoPopover.vue`にはフォーカストラップが無いため、ここで自前実装した分を検証する。
 */
beforeEach(() => document.body.replaceChildren());

describe("SettingsForm", () => {
  it("開いた直後、最初の入力欄（ホスト）へフォーカスする", async () => {
    const w = mount(SettingsForm, { attachTo: document.body });
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(w.get("#sf-host").element);
  });

  it("最後の要素でTabを押すと最初の要素へ回る（フォーカストラップ）", async () => {
    const w = mount(SettingsForm, { attachTo: document.body });
    await nextTick();
    const save = w.get('button[type="submit"]').element as HTMLButtonElement;
    save.focus();
    await w.get(".settings-form").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(w.get("#sf-host").element);
  });

  it("最初の要素でShift+Tabを押すと最後の要素へ回る", async () => {
    const w = mount(SettingsForm, { attachTo: document.body });
    await nextTick();
    const host = w.get("#sf-host").element as HTMLInputElement;
    host.focus();
    await w.get(".settings-form").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(w.get('button[type="submit"]').element);
  });

  it("Escapeでcancelを発火する", async () => {
    const w = mount(SettingsForm, { attachTo: document.body });
    await w.get(".settings-form").trigger("keydown", { key: "Escape" });
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("バックドロップのクリックでもcancelを発火する", async () => {
    const w = mount(SettingsForm, { attachTo: document.body });
    await w.get(".backdrop").trigger("click");
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("入力して保存すると、入力値でsaveを発火する（空欄は省く）", async () => {
    const w = mount(SettingsForm, { attachTo: document.body });
    await w.get("#sf-host").setValue("AS400");
    await w.get("#sf-port").setValue("992");
    await w.get("#sf-user").setValue("MYUSER");
    await w.get(".settings-form").trigger("submit");
    const saved = w.emitted("save")?.[0]?.[0];
    expect(saved).toEqual({ host: "AS400", port: 992, tls: true, user: "MYUSER" });
  });

  it("初期値（initial）があればフィールドへ反映する", () => {
    const w = mount(SettingsForm, {
      props: { initial: { host: "H", port: 23, tls: false, user: "U" } },
      attachTo: document.body
    });
    expect((w.get("#sf-host").element as HTMLInputElement).value).toBe("H");
    expect((w.get("#sf-port").element as HTMLInputElement).value).toBe("23");
    expect((w.get("#sf-tls").element as HTMLInputElement).checked).toBe(false);
    expect((w.get("#sf-user").element as HTMLInputElement).value).toBe("U");
  });
});
