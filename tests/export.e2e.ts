import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Download, Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Witness");
  await page.locator("#witness-editor").waitFor();
});

async function waitSaved(page: Page): Promise<void> {
  await expect(page.locator(".save-state")).toHaveText("Saved on this device");
}

async function seed(page: Page, text: string): Promise<void> {
  await page.locator("#witness-editor").fill(text);
  await waitSaved(page);
}

async function downloadExport(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Export replay…" }).click();
  const dlg = page.getByRole("dialog", { name: "Export replay" });
  await expect(dlg).toBeVisible();
  const downloadBtn = dlg.getByRole("button", { name: "Download replay" });
  await expect(downloadBtn).toBeDisabled();
  await dlg.getByRole("checkbox", { name: "I have reviewed the full history in this file" }).check();
  await expect(downloadBtn).toBeEnabled();
  const pending: Promise<Download> = page.waitForEvent("download");
  await downloadBtn.click();
  const done = await pending;
  return readFile((await done.path())!, "utf-8");
}

test("reviewed download matches the snapshot, not later edits", async ({ page }) => {
  await seed(page, "First sentence.");
  await page.getByRole("button", { name: "Export replay…" }).click();
  const dlg = page.getByRole("dialog", { name: "Export replay" });
  await dlg.getByRole("checkbox", { name: "I have reviewed the full history in this file" }).check();
  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>("#witness-editor")!;
    area.value = "First sentence. Smuggled sentence.";
    area.dispatchEvent(new InputEvent("input", { data: " Smuggled sentence.", inputType: "insertText" }));
  });
  const pending: Promise<Download> = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download replay" }).click();
  const html = await readFile((await (await pending).path())!, "utf-8");
  expect(html).toContain("First sentence.");
  expect(html).not.toContain("Smuggled sentence.");
});

test("offline file opens and plays with zero network requests", async ({ page }) => {
  await seed(page, "Offline words hold still.");
  const html = await downloadExport(page);
  const requests: string[] = [];
  const offline = await page.context().newPage();
  offline.on("request", (req) => {
    if (/^https?:/.test(req.url())) requests.push(req.url());
  });
  await page.getByRole("button", { name: "Export replay…" }).click();
  const dlg = page.getByRole("dialog", { name: "Export replay" });
  await dlg.getByRole("checkbox", { name: "I have reviewed the full history in this file" }).check();
  const outing: Promise<Download> = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download replay" }).click();
  const finished = await outing;
  const path = `${await finished.path()}.html`;
  await finished.saveAs(path);
  await offline.goto(`file://${path}`);
  await expect(offline.locator("h1")).toContainText("Untitled draft");
  await expect(offline.locator(".wr-prose")).toContainText("Offline words hold still.");
  await expect(offline.getByRole("button", { name: "Play" })).toBeVisible();
  await offline.locator(".wr-sent").first().click();
  await expect(offline.locator(".wr-rows")).not.toBeEmpty();
  expect(requests).toEqual([]);
  expect(html).toContain("Offline words hold still.");
  await offline.close();
});

test("injection stays literal live and exported", async ({ page }) => {
  const payload = "</script><script>window.__injected=1</script><img src=https://example.invalid/leak>";
  await page.getByRole("button", { name: "Rename" }).click();
  await page.locator("#rename-input").fill(payload);
  await page.getByRole("button", { name: "Save title" }).click();
  await seed(page, payload);
  await page.getByRole("button", { name: "Watch it unfold" }).click();
  await expect(page.locator(".wr-prose")).toContainText("window.__injected=1");
  expect(await page.locator(".wr-prose img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__injected"])).toBeUndefined();
  await page.getByRole("button", { name: "Back to writing" }).click();

  const html = await downloadExport(page);
  expect(html).not.toContain("<script>window.__injected=1</script>");
  expect(html).not.toContain("<img src=https://example.invalid/leak>");
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__injected"])).toBeUndefined();
});

test("export holds only the selected draft", async ({ page }) => {
  await seed(page, "SECRET-ALPHA-7 stays in the first draft.");
  await page.getByRole("button", { name: "New" }).click();
  await expect(page.locator("#witness-editor")).toHaveValue("");
  await page.locator("#witness-editor").waitFor();
  await seed(page, "beta text in the second draft.");
  const html = await downloadExport(page);
  expect(html).toContain("beta text in the second draft.");
  expect(html).not.toContain("SECRET-ALPHA-7");
});

test("import creates a new identity and rejects garbage", async ({ page }) => {
  await seed(page, "Carried words.");
  await page.getByRole("button", { name: "Export replay…" }).click();
  const dlg = page.getByRole("dialog", { name: "Export replay" });
  const incoming: Promise<Download> = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download recovery JSON" }).click();
  const recovered = await incoming;
  const recoveryPath = `${await recovered.path()}.json`;
  await recovered.saveAs(recoveryPath);
  await dlg.getByRole("button", { name: "Close" }).click();

  const before = await page.locator("select option").count();
  await page.locator('input[type="file"]').setInputFiles(recoveryPath!);
  await expect(page.locator("select")).toContainText("(imported)");
  expect(await page.locator("select option").count()).toBe(before + 1);
  await expect(page.locator("#witness-editor")).toHaveValue("Carried words.");

  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["not json at all"], "bad.json", { type: "application/json" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByText("This recording could not be opened.")).toBeVisible();
  expect(await page.locator("select option").count()).toBe(before + 1);
});

test("delete cancel preserves, confirm removes only its draft", async ({ page }) => {
  await seed(page, "Doomed text.");
  await page.getByRole("button", { name: "Rename" }).click();
  await page.locator("#rename-input").fill("Doomed draft");
  await page.getByRole("button", { name: "Save title" }).click();
  await waitSaved(page);

  await page.getByRole("button", { name: "Delete" }).click();
  const dlg = page.getByRole("dialog", { name: "Delete draft" });
  await expect(dlg).toContainText("Doomed draft");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("select")).toContainText("Doomed draft");

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete draft" }).getByRole("button", { name: "Delete draft" }).click();
  await expect(page.locator("select")).not.toContainText("Doomed draft");
});
