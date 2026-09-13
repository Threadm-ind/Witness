import "./styles.css";
import replayJs from "../.generated/replay.js?raw";
import replayCss from "./styles.css?inline";
import {
  MAX_SERIALIZED_BYTES,
  MAX_TITLE_CHARS,
  applyEdit,
  textAt,
  validateRecording,
} from "./record.ts";
import type { Edit, Recording } from "./record.ts";
import {
  appendEdit,
  createDocument,
  deleteDocument,
  listDocuments,
  loadDocument,
  renameDocument,
} from "./store.ts";
import { mountEditor } from "./editor.ts";
import { formatTime, mountReplay } from "./replay.ts";
import { buildExportHtml, downloadExportFile, downloadRecording, prepareImport } from "./export.ts";
import { buildExample } from "./example.ts";

type Queued = { edit: Edit; expectedSeq: number; nextText: string };

const state = {
  recording: null as Recording | null,
  savedSeq: 0,
  savedText: "",
  latestText: "",
  queue: [] as Queued[],
  draining: false,
  drainWaiters: [] as (() => void)[],
  storageOk: true,
  failed: null as string | null,
  conflict: false,
  disposeView: null as (() => void) | null,
  replaying: false,
};

function el<T extends HTMLElement>(tag: string, className: string, text = ""): T {
  const node = document.createElement(tag) as T;
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, primary = false): HTMLButtonElement {
  const b = el<HTMLButtonElement>("button", primary ? "btn btn-primary" : "btn");
  b.type = "button";
  b.textContent = label;
  return b;
}

const app = document.getElementById("app")!;
const head = el<HTMLElement>("header", "app-head");
const brand = el<HTMLHeadingElement>("h1", "brand", "Witness");
const docBar = el<HTMLDivElement>("div", "doc-bar");
const docSelect = el<HTMLSelectElement>("select", "");
docSelect.setAttribute("aria-label", "Open draft");
const saveState = el<HTMLSpanElement>("span", "save-state", "Opening your draft…");
saveState.setAttribute("aria-live", "polite");
docBar.append(docSelect);
head.append(brand, docBar, saveState);

const main = el<HTMLElement>("main", "prose-col");
const actions = el<HTMLDivElement>("div", "doc-actions");
const view = el<HTMLDivElement>("div", "");
view.id = "view";
const notice = el<HTMLDivElement>("div", "live-quiet", "");
notice.setAttribute("aria-live", "polite");
main.append(actions, view, notice);
const foot = el<HTMLElement>("footer", "app-foot", "© 2026 Alex Evoy · Witness keeps your writing on this device.");
app.append(head, main, foot);

const dialogHost = el<HTMLDivElement>("div", "");
app.append(dialogHost);

function setSaveStatus(): void {
  saveState.textContent = !state.storageOk
    ? "Not saved on this device. Download a recovery file before leaving."
    : state.failed ?? (state.queue.length > 0 || state.draining ? "Saving…" : "Saved on this device");
}

function editorArea(): HTMLTextAreaElement | null {
  return view.querySelector<HTMLTextAreaElement>("#witness-editor");
}

function finishComposition(): void {
  const active = document.activeElement as HTMLElement | null;
  if (active && typeof active.blur === "function") active.blur();
}

function snapshot(): Recording {
  if (!state.recording) throw new Error("No draft open.");
  return validateRecording(JSON.parse(JSON.stringify(state.recording)));
}

// ---------- dialogs ----------

function openDialog(title: string, build: (body: HTMLElement, close: () => void) => void): () => void {
  const opener = document.activeElement as HTMLElement | null;
  const backdrop = el<HTMLDivElement>("div", "dlg-backdrop");
  const dlg = el<HTMLDivElement>("div", "dlg");
  dlg.setAttribute("role", "dialog");
  dlg.setAttribute("aria-modal", "true");
  dlg.setAttribute("aria-label", title);
  const heading = el<HTMLHeadingElement>("h2", "", title);
  const body = el<HTMLDivElement>("div", "");
  dlg.append(heading, body);
  backdrop.appendChild(dlg);
  dialogHost.appendChild(backdrop);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    opener?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      const focusables = [...dlg.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, [tabindex]",
      )].filter((n) => !n.hasAttribute("disabled") && n.tabIndex >= 0);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  build(body, close);
  const firstInput = dlg.querySelector<HTMLElement>("button, input, select, textarea");
  firstInput?.focus();
  return close;
}

// ---------- save queue ----------

function wakeDrain(): void {
  const waiters = state.drainWaiters.splice(0);
  for (const w of waiters) w();
}

async function drain(): Promise<void> {
  if (state.draining) {
    await new Promise<void>((resolve) => state.drainWaiters.push(resolve));
    return;
  }
  if (!state.recording || !state.storageOk || state.conflict) return;
  state.draining = true;
  setSaveStatus();
  try {
    while (state.queue.length > 0 && !state.conflict) {
      const head = state.queue[0]!;
      try {
        await appendEdit(state.recording.id, head.expectedSeq, head.edit, head.nextText);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Save failed.";
        if (message === "STALE_DRAFT") {
          state.conflict = true;
          showConflict();
        } else if (message.includes("reached its limit")) {
          revertOverLimit();
        } else {
          state.failed = `Not saved on this device. ${message} Download a recovery file before leaving.`;
          showRecovery();
        }
        break;
      }
      state.queue.shift();
      state.savedSeq = head.expectedSeq + 1;
      state.savedText = head.nextText;
    }
  } finally {
    state.draining = false;
    setSaveStatus();
    wakeDrain();
  }
}

function onEditorChange(recording: Recording): void {
  state.failed = null;
  const base = state.savedSeq + state.queue.length;
  let prev = state.latestText;
  for (let i = base; i < recording.edits.length; i++) {
    const edit = recording.edits[i]!;
    const nextText = applyEdit(prev, edit);
    state.queue.push({ edit, expectedSeq: state.savedSeq + state.queue.length, nextText });
    prev = nextText;
  }
  state.latestText = prev;
  void drain();
  syncActions();
  refreshExplainer();
}

function syncActions(): void {
  const key = `${state.replaying}:${(state.recording?.edits.length ?? 0) === 0}`;
  if (key !== actionKey) renderActions();
}

function revertOverLimit(): void {
  if (!state.recording) return;
  const attempted = editorArea()?.value ?? state.latestText;
  state.recording.edits.length = state.savedSeq;
  state.latestText = state.savedText;
  state.queue.length = 0;
  state.failed = "This recording has reached its limit. Export it before starting another.";
  mountEditView();
  const area = editorArea();
  area?.focus();
  showAttemptRecovery(attempted);
  setSaveStatus();
}

function showAttemptRecovery(attempted: string): void {
  view.querySelector(".recovery-box")?.remove();
  if (attempted === state.savedText) return;
  const box = el<HTMLDivElement>("div", "recovery-box");
  const msg = el<HTMLParagraphElement>("p", "notice-error", state.failed ?? "");
  const label = el<HTMLLabelElement>("label", "field-label", "Your unsaved attempt (not recorded — copy it before it is lost)");
  const area = el<HTMLTextAreaElement>("textarea", "");
  area.value = attempted;
  area.readOnly = true;
  const copy = button("Copy attempt");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(area.value);
      copy.textContent = "Copied";
    } catch {
      area.select();
    }
  });
  box.append(msg, label, area, copy);
  view.appendChild(box);
}

function downloadMemoryJson(suffix = "recovery"): void {
  if (!state.recording) return;
  const blob = new Blob([JSON.stringify(state.recording)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `witness-${state.recording.id}-${suffix}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showRecovery(): void {
  view.querySelector(".recovery-box")?.remove();
  const box = el<HTMLDivElement>("div", "recovery-box");
  const msg = el<HTMLParagraphElement>("p", "notice-error", state.failed ?? "");
  const retry = button("Retry saving", true);
  retry.addEventListener("click", () => {
    state.failed = null;
    box.remove();
    void drain();
  });
  const dl = button("Download recovery file");
  dl.addEventListener("click", () => downloadMemoryJson());
  box.append(msg, retry, dl);
  box.style.display = "flex";
  box.style.gap = "0.5rem";
  box.style.flexWrap = "wrap";
  view.appendChild(box);
  setSaveStatus();
}

function showConflict(): void {
  const area = editorArea();
  if (area) area.disabled = true;
  view.querySelector(".recovery-box")?.remove();
  const box = el<HTMLDivElement>("div", "recovery-box");
  const msg = el<HTMLParagraphElement>(
    "p",
    "notice-error",
    "This draft changed in another tab. Editing is paused here so nothing is silently lost. " +
      "Your unsaved text is preserved in memory on this page.",
  );
  const dl = button("Download recovery file");
  dl.addEventListener("click", () => downloadMemoryJson("branch"));
  const reload = button("Reload saved draft", true);
  reload.addEventListener("click", () => {
    const discard = state.queue.length === 0 || state.latestText === state.savedText
      ? true
      : confirm("Reloading discards unsaved text on this page. Download a recovery file first if you need it. Reload?");
    if (!discard) return;
    void openDoc(state.recording!.id);
  });
  box.append(msg, dl, reload);
  view.appendChild(box);
  setSaveStatus();
}

// ---------- views ----------

function refreshExplainer(): void {
  const existing = main.querySelector(".explainer");
  const empty = (state.recording?.edits.length ?? 0) === 0 && !state.replaying;
  if (empty && !existing) {
    const p = el<HTMLParagraphElement>(
      "p",
      "explainer",
      "Witness keeps a private record of how your writing unfolds — every keystroke stays on this device until you choose to export it.",
    );
    main.insertBefore(p, actions.nextSibling);
  } else if (!empty && existing) {
    existing.remove();
  }
}

let actionKey = "";
function renderActions(): void {
  actionKey = `${state.replaying}:${(state.recording?.edits.length ?? 0) === 0}`;
  actions.innerHTML = "";
  if (state.replaying) {
    const back = button("Back to writing", true);
    back.addEventListener("click", () => mountEditView());
    actions.append(back);
    return;
  }
  const watch = button("Watch it unfold", true);
  watch.disabled = (state.recording?.edits.length ?? 0) === 0;
  watch.addEventListener("click", () => mountReplayView());
  const exportBtn = button("Export replay…");
  exportBtn.disabled = (state.recording?.edits.length ?? 0) === 0;
  exportBtn.addEventListener("click", () => openExportDialog());
  const example = button("Watch an example");
  example.addEventListener("click", () => openExampleDialog());
  const openFile = button("Open recording…");
  openFile.addEventListener("click", () => fileInput.click());
  actions.append(watch, exportBtn, example, openFile);
}

function mountEditView(): void {
  state.disposeView?.();
  state.disposeView = null;
  state.replaying = false;
  view.innerHTML = "";
  if (!state.recording) return;
  state.disposeView = mountEditor(view, state.recording, onEditorChange);
  renderActions();
  refreshExplainer();
}

function mountReplayView(): void {
  if (!state.recording || state.recording.edits.length === 0) return;
  finishComposition();
  let frozen: Recording;
  try {
    frozen = snapshot();
  } catch {
    notice.textContent = "The draft could not be frozen for replay. Your text is still here.";
    return;
  }
  state.disposeView?.();
  state.disposeView = null;
  state.replaying = true;
  view.innerHTML = "";
  state.disposeView = mountReplay(view, frozen);
  renderActions();
  refreshExplainer();
}

// ---------- documents ----------

async function refreshDocList(): Promise<{ id: string; title: string; updatedSeq: number; createdAt: string }[]> {
  const rows = await listDocuments();
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1));
  docSelect.innerHTML = "";
  for (const row of rows) {
    const opt = document.createElement("option");
    opt.value = row.id;
    opt.textContent = row.title;
    docSelect.appendChild(opt);
  }
  return rows;
}

function blankRecording(): Recording {
  return {
    schema: "witness-recording@1",
    id: crypto.randomUUID(),
    title: "Untitled draft",
    createdAt: new Date().toISOString(),
    initialText: "",
    edits: [],
  };
}

function openState(recording: Recording): void {
  state.recording = recording;
  state.savedSeq = recording.edits.length;
  state.savedText = textAt(recording, recording.edits.length);
  state.latestText = state.savedText;
  state.queue.length = 0;
  state.failed = null;
  state.conflict = false;
  docSelect.value = recording.id;
  setSaveStatus();
  mountEditView();
}

async function openDoc(id: string): Promise<void> {
  if (state.draining) await drain();
  if (state.queue.length > 0) {
    notice.textContent = "Unsaved changes need recovery before switching drafts. Resolve the notice above first.";
    docSelect.value = state.recording?.id ?? "";
    return;
  }
  finishComposition();
  saveState.textContent = "Opening your draft…";
  try {
    const recording = await loadDocument(id);
    openState(recording);
    notice.textContent = "";
  } catch {
    notice.textContent = "That draft could not be opened. Your other drafts have not changed.";
    if (state.recording) docSelect.value = state.recording.id;
  }
}

async function newDoc(): Promise<void> {
  if (state.draining) await drain();
  if (state.queue.length > 0) {
    notice.textContent = "Unsaved changes need recovery before starting a new draft.";
    return;
  }
  finishComposition();
  const recording = blankRecording();
  if (state.storageOk) {
    try {
      await createDocument(recording);
    } catch (err) {
      state.storageOk = false;
      state.failed = "Not saved on this device. Download a recovery file before leaving.";
    }
  }
  await refreshDocList().catch(() => []);
  openState(recording);
}

async function startup(): Promise<void> {
  renderActions();
  docSelect.addEventListener("change", () => void openDoc(docSelect.value));
  window.addEventListener("beforeunload", (e) => {
    if (state.queue.length > 0 || state.failed || state.conflict) e.preventDefault();
  });

  let rows: { id: string; title: string; updatedSeq: number; createdAt: string }[] = [];
  try {
    rows = await refreshDocList();
  } catch {
    state.storageOk = false;
    openState(blankRecording());
    setSaveStatus();
    showRecovery();
    wireDocButtons();
    return;
  }
  if (rows.length === 0) {
    const recording = blankRecording();
    try {
      await createDocument(recording);
      await refreshDocList();
    } catch {
      state.storageOk = false;
    }
    openState(recording);
    if (!state.storageOk) showRecovery();
    wireDocButtons();
    return;
  }
  try {
    const recording = await loadDocument(rows[0]!.id);
    openState(recording);
  } catch {
    state.recording = null;
    view.innerHTML = "";
    const warn = el<HTMLDivElement>("div", "recovery-box");
    const msg = el<HTMLParagraphElement>(
      "p",
      "notice-error",
      `The saved data for “${rows[0]!.title}” looks damaged. Its stored rows are untouched — nothing was reset or deleted.`,
    );
    const fresh = button("Start a fresh draft", true);
    fresh.addEventListener("click", () => {
      warn.remove();
      void newDoc();
    });
    const remove = button("Delete damaged draft");
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete “${rows[0]!.title}” and its stored rows?`)) return;
      try {
        await deleteDocument(rows[0]!.id);
      } catch {
        notice.textContent = "The damaged draft could not be deleted. It is still listed.";
        return;
      }
      warn.remove();
      await startupRefresh();
    });
    warn.append(msg, fresh, remove);
    view.appendChild(warn);
    saveState.textContent = "Saved on this device";
  }
  wireDocButtons();
}

async function startupRefresh(): Promise<void> {
  const rows = await refreshDocList().catch(() => []);
  if (rows.length === 0) {
    await newDoc();
    return;
  }
  await openDoc(rows[0]!.id);
}

let docButtonsWired = false;
function wireDocButtons(): void {
  if (docButtonsWired) return;
  docButtonsWired = true;
  const fresh = button("New");
  fresh.addEventListener("click", () => void newDoc());
  const rename = button("Rename");
  rename.addEventListener("click", () => openRenameDialog());
  const remove = button("Delete");
  remove.addEventListener("click", () => openDeleteDialog());
  docBar.append(fresh, rename, remove);
}

// ---------- rename / delete / import ----------

function openRenameDialog(): void {
  if (!state.recording) return;
  const current = state.recording.title;
  openDialog("Rename draft", (body, close) => {
    const label = el<HTMLLabelElement>("label", "field-label", "Title");
    const input = el<HTMLInputElement>("input", "");
    input.type = "text";
    input.value = current;
    input.maxLength = MAX_TITLE_CHARS;
    label.htmlFor = "rename-input";
    input.id = "rename-input";
    const err = el<HTMLParagraphElement>("p", "notice-error", "");
    const row = el<HTMLDivElement>("div", "dlg-row");
    const save = button("Save title", true);
    const cancel = button("Cancel");
    cancel.addEventListener("click", close);
    save.addEventListener("click", async () => {
      const title = input.value.trim() === "" ? "Untitled draft" : input.value;
      if ([...title].length > MAX_TITLE_CHARS) {
        err.textContent = "Title exceeds 120 characters.";
        return;
      }
      try {
        await renameDocument(state.recording!.id, title);
      } catch {
        err.textContent = "The title could not be saved. Your draft text is unchanged.";
        return;
      }
      state.recording!.title = title;
      await refreshDocList().catch(() => []);
      docSelect.value = state.recording!.id;
      close();
    });
    row.append(save, cancel);
    body.append(label, input, err, row);
  });
}

function openDeleteDialog(): void {
  if (!state.recording) return;
  const target = state.recording;
  openDialog("Delete draft", (body, close) => {
    const msg = el<HTMLParagraphElement>(
      "p",
      "",
      `Delete “${target.title}” with its ${target.edits.length} recorded edits? This cannot be undone.`,
    );
    const err = el<HTMLParagraphElement>("p", "notice-error", "");
    const row = el<HTMLDivElement>("div", "dlg-row");
    const cancel = button("Cancel", true);
    cancel.addEventListener("click", close);
    const confirmBtn = button("Delete draft");
    confirmBtn.classList.add("btn-danger");
    confirmBtn.addEventListener("click", async () => {
      try {
        await deleteDocument(target.id);
      } catch {
        err.textContent = "The draft could not be deleted. It is still listed.";
        return;
      }
      close();
      if (state.recording?.id === target.id) {
        state.recording = null;
        await startupRefresh();
      } else {
        await refreshDocList().catch(() => []);
      }
    });
    row.append(cancel, confirmBtn);
    body.append(msg, err, row);
  });
}

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "application/json,.json";
fileInput.hidden = true;
document.body.appendChild(fileInput);
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  void importFile(file);
});

async function importFile(file: File): Promise<void> {
  const isJson = file.type.includes("json") || file.name.toLowerCase().endsWith(".json");
  if (!isJson) {
    notice.textContent = "This recording could not be opened. Your existing drafts have not changed.";
    return;
  }
  if (file.size > MAX_SERIALIZED_BYTES) {
    notice.textContent = "This recording could not be opened. Your existing drafts have not changed.";
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    notice.textContent = "This recording could not be opened. Your existing drafts have not changed.";
    return;
  }
  let imported: Recording;
  try {
    imported = prepareImport(parsed);
  } catch {
    notice.textContent = "This recording could not be opened. Your existing drafts have not changed.";
    return;
  }
  try {
    await createDocument(imported);
  } catch {
    notice.textContent = "This recording could not be opened. Your existing drafts have not changed.";
    return;
  }
  await refreshDocList().catch(() => []);
  notice.textContent = `Imported as “${imported.title}”.`;
  await openDoc(imported.id);
}

// ---------- export dialog ----------

const REV_PAGE = 200;

function openExportDialog(): void {
  if (!state.recording || state.recording.edits.length === 0) return;
  finishComposition();
  let frozen: Recording;
  try {
    frozen = snapshot();
  } catch {
    notice.textContent = "The replay file could not be created. Your draft is still here.";
    return;
  }
  openDialog("Export replay", (body, close) => {
    const warn = el<HTMLDivElement>("div", "warning-box", "");
    warn.textContent =
      "This file includes deleted text and earlier drafts. Anyone you share it with can read them. It is not encrypted.";
    const err = el<HTMLParagraphElement>("p", "notice-error", "");
    const errDesc = el<HTMLParagraphElement>("p", "live-quiet", "");
    errDesc.id = "export-err-desc";
    err.setAttribute("aria-describedby", "export-err-desc");

    const revHead = el<HTMLHeadingElement>("h3", "", "Revision list");
    const revList = el<HTMLUListElement>("ul", "rev-list");
    let shownRevs = REV_PAGE;
    const moreRevs = button("Show more revisions");
    const renderRevs = (): void => {
      revList.innerHTML = "";
      for (const edit of frozen.edits.slice(0, shownRevs)) {
        const item = document.createElement("li");
        const headLine = el<HTMLSpanElement>(
          "span",
          "",
          `Edit ${edit.seq} · ${edit.kind} · ${formatTime(edit.elapsedMs)}`,
        );
        item.appendChild(headLine);
        const excerptText = edit.removed !== "" || edit.inserted === ""
          ? `−${edit.removed.slice(0, 60)}${edit.removed.length > 60 ? "…" : ""}`
          : `+${edit.inserted.slice(0, 60)}${edit.inserted.length > 60 ? "…" : ""}`;
        const excerpt = el<HTMLSpanElement>("span", "rev-excerpt", excerptText);
        item.appendChild(excerpt);
        revList.appendChild(item);
      }
      moreRevs.hidden = shownRevs >= frozen.edits.length;
      moreRevs.textContent = `Show more revisions (${Math.max(0, frozen.edits.length - shownRevs)} more)`;
    };
    moreRevs.addEventListener("click", () => {
      shownRevs += REV_PAGE;
      renderRevs();
    });
    renderRevs();

    const previewHead = el<HTMLHeadingElement>("h3", "", "Replay preview");
    const previewNote = el<HTMLParagraphElement>(
      "p",
      "live-quiet",
      "This preview is the exact snapshot that will be downloaded.",
    );
    const previewHost = el<HTMLDivElement>("div", "");
    const disposePreview = mountReplay(previewHost, frozen);

    const checkLabel = el<HTMLLabelElement>("label", "review-check", "");
    const check = el<HTMLInputElement>("input", "");
    check.type = "checkbox";
    const checkText = el<HTMLSpanElement>("span", "", "I have reviewed the full history in this file");
    checkLabel.append(check, checkText);

    const row = el<HTMLDivElement>("div", "dlg-row");
    const download = button("Download replay", true);
    download.disabled = true;
    check.addEventListener("change", () => {
      download.disabled = !check.checked;
    });
    download.addEventListener("click", () => {
      try {
        const html = buildExportHtml(frozen, replayJs, replayCss);
        downloadExportFile(frozen, html);
      } catch {
        err.textContent = "The replay file could not be created. Your draft is still here.";
        errDesc.textContent = "Nothing was downloaded. The preview above and your draft are unchanged.";
        return;
      }
      close();
    });
    const finalOnly = button("Download final text only (.txt, no history)");
    finalOnly.addEventListener("click", () => {
      const blob = new Blob([textAt(frozen, frozen.edits.length)], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `witness-${frozen.id}.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const recovery = button("Download recovery JSON");
    recovery.addEventListener("click", () => downloadRecording(frozen));
    const cancel = button("Close");
    cancel.addEventListener("click", () => {
      disposePreview();
      close();
    });
    row.append(download, finalOnly, recovery, cancel);
    body.append(warn, err, errDesc, revHead, revList, moreRevs, previewHead, previewNote, previewHost, checkLabel, row);
  });
}

// ---------- example ----------

function openExampleDialog(): void {
  let example: Recording;
  try {
    example = buildExample();
  } catch {
    notice.textContent = "The example could not be built.";
    return;
  }
  openDialog("Illustrative example", (body, close) => {
    const note = el<HTMLParagraphElement>(
      "p",
      "live-quiet",
      "An illustration of how Witness records revisions — not a recording of real work. " +
        "It is never saved over your drafts.",
    );
    const host = el<HTMLDivElement>("div", "");
    const dispose = mountReplay(host, example);
    const row = el<HTMLDivElement>("div", "dlg-row");
    const cancel = button("Close", true);
    cancel.addEventListener("click", () => {
      dispose();
      close();
    });
    row.append(cancel);
    body.append(note, host, row);
  });
}

void startup();
