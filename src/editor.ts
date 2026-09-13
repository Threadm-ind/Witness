import { makeEdit, textAt } from "./record.ts";
import type { EditKind, Recording } from "./record.ts";

function kindForInputType(inputType: string): EditKind {
  if (inputType === "insertFromPaste" || inputType === "insertFromDrop") return "paste";
  if (inputType === "historyUndo") return "undo";
  if (inputType === "historyRedo") return "redo";
  if (inputType.startsWith("insert") || inputType.startsWith("delete")) return "typing";
  return "edit";
}

export function mountEditor(
  root: HTMLElement,
  recording: Recording,
  onChange: (recording: Recording) => void,
): () => void {
  const sessionStart = performance.now();
  const baseElapsed = recording.edits.length > 0
    ? recording.edits[recording.edits.length - 1]!.elapsedMs
    : 0;
  let lastText = textAt(recording, recording.edits.length);
  let pendingInputType = "";
  let composing = false;
  let skipNextInput = false;

  const label = document.createElement("label");
  label.textContent = "Your draft";
  const area = document.createElement("textarea");
  area.id = "witness-editor";
  area.value = lastText;
  area.rows = 18;
  label.htmlFor = area.id;

  const notice = document.createElement("p");
  notice.textContent = "Recording changes on this page";

  const recordValue = (next: string, kind: EditKind): void => {
    if (next === lastText) return;
    const edit = makeEdit(lastText, next, {
      seq: recording.edits.length + 1,
      elapsedMs: baseElapsed + (performance.now() - sessionStart),
      kind,
    });
    if (!edit) return;
    recording.edits.push(edit);
    lastText = next;
    onChange(recording);
  };

  const onBeforeInput = (e: Event): void => {
    pendingInputType = (e as InputEvent).inputType ?? "";
  };

  const onCompositionStart = (): void => {
    composing = true;
  };

  const onCompositionEnd = (): void => {
    composing = false;
    // Capture the finalized composition once; the input event that follows
    // with the identical value is deduplicated below.
    skipNextInput = true;
    recordValue(area.value, "composition");
  };

  const onInput = (e: Event): void => {
    if (composing || (e as InputEvent).isComposing) return;
    if (skipNextInput) {
      skipNextInput = false;
      if (area.value === lastText) {
        pendingInputType = "";
        return;
      }
      // Value moved on past composition end: record it under its own type.
    }
    const kind = pendingInputType ? kindForInputType(pendingInputType) : "edit";
    pendingInputType = "";
    recordValue(area.value, kind);
  };

  area.addEventListener("beforeinput", onBeforeInput);
  area.addEventListener("compositionstart", onCompositionStart);
  area.addEventListener("compositionend", onCompositionEnd);
  area.addEventListener("input", onInput);

  root.append(label, area, notice);

  return () => {
    area.removeEventListener("beforeinput", onBeforeInput);
    area.removeEventListener("compositionstart", onCompositionStart);
    area.removeEventListener("compositionend", onCompositionEnd);
    area.removeEventListener("input", onInput);
    root.innerHTML = "";
  };
}
