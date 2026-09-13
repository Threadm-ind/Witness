import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Witness");
  await page.locator("#witness-editor").waitFor();
});

async function waitSaved(page): Promise<void> {
  await expect(page.locator(".save-state")).toHaveText("Saved on this device");
}

test("typing, paste and undo round-trip through replay", async ({ page, context, browserName }) => {
  const editor = page.locator("#witness-editor");
  await editor.click();
  await page.keyboard.type("Hello world");
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await page.evaluate(() => navigator.clipboard.writeText("line one\nline two"));
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+v");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  const final = await editor.inputValue();
  await waitSaved(page);

  await page.getByRole("button", { name: "Watch it unfold" }).click();
  await expect(page.locator(".wr-prose")).toContainText(final.split("\n")[0]!);
  const slider = page.locator(".wr-slider");
  const max = await slider.getAttribute("max");
  await expect(slider).toHaveValue(max!);
  await slider.fill("0");
  await expect(page.locator(".wr-prose")).toHaveText("Write something to begin");
  await slider.fill(max!);
  await expect(page.locator(".wr-prose")).toContainText("line two");

  await page.getByRole("button", { name: "Back to writing" }).click();
  await expect(page.locator("#witness-editor")).toHaveValue(final);
});

test("reload restores text, title and history", async ({ page }) => {
  await page.locator("#witness-editor").fill("A durable sentence.");
  await page.getByRole("button", { name: "Rename" }).click();
  await page.locator("#rename-input").fill("Durable draft");
  await page.getByRole("button", { name: "Save title" }).click();
  await waitSaved(page);

  await page.reload();
  await page.locator("#witness-editor").waitFor();
  await expect(page.locator("#witness-editor")).toHaveValue("A durable sentence.");
  await expect(page.locator("select")).toContainText("Durable draft");
  await page.getByRole("button", { name: "Watch it unfold" }).click();
  await expect(page.locator(".wr-prose")).toContainText("A durable sentence.");
});

test("a stale tab is stopped with its text preserved", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  for (const p of [first, second]) {
    await p.goto("/");
    await p.locator("#witness-editor").waitFor();
  }
  await first.locator("#witness-editor").fill("Saved from the first tab.");
  await expect(first.locator(".save-state")).toHaveText("Saved on this device");

  await second.locator("#witness-editor").fill("Unsaved branch from the second tab.");
  await expect(second.getByText("changed in another tab")).toBeVisible();
  await expect(second.locator("#witness-editor")).toBeDisabled();
  await expect(second.locator("#witness-editor")).toHaveValue("Unsaved branch from the second tab.");

  const download = second.waitForEvent("download");
  await second.getByRole("button", { name: "Download recovery file" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toContain("witness-");
  await first.close();
  await second.close();
});

test("storage failure keeps text and offers recovery", async ({ page }) => {
  await page.locator("#witness-editor").fill("Base text.");
  await waitSaved(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("witness", 999);
        req.onupgradeneeded = () => resolve();
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
      }),
  );
  await page.locator("#witness-editor").fill("Base text plus unsaved words.");
  await expect(page.locator(".save-state")).toContainText("Not saved on this device");
  await expect(page.locator("#witness-editor")).toHaveValue("Base text plus unsaved words.");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download recovery file" }).click();
  const file = await download;
  const path = await file.path();
  const json = JSON.parse(await readFile(path!, "utf-8"));
  expect(JSON.stringify(json)).toContain("plus unsaved words");
});

test("a finalized composition is recorded once", async ({ page }) => {
  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>("#witness-editor")!;
    area.focus();
    area.value = "こんにちは";
    area.dispatchEvent(new CompositionEvent("compositionstart"));
    area.dispatchEvent(new InputEvent("input", { data: "こんにちは", isComposing: true }));
    area.dispatchEvent(new CompositionEvent("compositionend", { data: "こんにちは" }));
    area.dispatchEvent(new InputEvent("input", { data: "こんにちは", isComposing: false }));
  });
  await expect(page.locator("#witness-editor")).toHaveValue("こんにちは");
  await waitSaved(page);
  await page.getByRole("button", { name: "Watch it unfold" }).click();
  await expect(page.locator(".wr-prose")).toHaveText("こんにちは");
});
