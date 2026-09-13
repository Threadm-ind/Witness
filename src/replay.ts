import { applyEdit, textAt } from "./record.ts";
import type { Recording, Span } from "./record.ts";
import { coalesceRows, historyForSpan, sentenceSpans } from "./history.ts";
import type { HistoryRow } from "./history.ts";

export type ReplaySpeed = 1 | 4 | 16;
export const SKIP_CAP_MS = 1500;
export const CHECKPOINT_EVERY = 100;
export const HISTORY_PAGE = 50;

const RELABEL: Record<string, string> = {
  edited: "Edited here",
  replaced: "Passage replaced here",
  introduced: "Introduced here",
  "context-expanded": "Earlier surrounding passage",
};

let mountCount = 0;

export function elapsedAt(recording: Recording, seq: number): number {
  if (seq <= 0) return 0;
  return recording.edits[Math.min(seq, recording.edits.length) - 1]!.elapsedMs;
}

export function rawGapMs(recording: Recording, seq: number): number {
  return elapsedAt(recording, seq) - elapsedAt(recording, seq - 1);
}

export function effectiveGapMs(rawMs: number, speed: ReplaySpeed, skipPauses: boolean): number {
  const capped = skipPauses ? Math.min(Math.max(0, rawMs), SKIP_CAP_MS) : Math.max(0, rawMs);
  return capped / speed;
}

export function checkpointTexts(recording: Recording, every = CHECKPOINT_EVERY): string[] {
  const points: string[] = [""];
  let text = "";
  for (let k = 1; k <= recording.edits.length; k++) {
    text = applyEdit(text, recording.edits[k - 1]!);
    if (k % every === 0) points[k / every] = text;
  }
  return points;
}

export function seekText(
  recording: Recording,
  checkpoints: string[],
  seq: number,
  every = CHECKPOINT_EVERY,
): string {
  const clamped = Math.max(0, Math.min(seq, recording.edits.length));
  const base = Math.floor(clamped / every);
  let text = checkpoints[base] ?? textAt(recording, base * every);
  for (let k = base * every + 1; k <= clamped; k++) {
    text = applyEdit(text, recording.edits[k - 1]!);
  }
  return text;
}

export function formatTime(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function mountReplay(root: HTMLElement, recording: Recording): () => void {
  const ctl = new AbortController();
  const on = (t: EventTarget, type: string, fn: (e: Event) => void): void => {
    t.addEventListener(type, fn as EventListener, { signal: ctl.signal });
  };
  const mountId = ++mountCount;
  const total = recording.edits.length;
  const checkpoints = checkpointTexts(recording);
  const reduceMotion =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let position = total;
  let playing = false;
  let speed: ReplaySpeed = 1;
  let skipPauses = true;
  let raf = 0;
  let lastTick = 0;
  let carry = 0;
  let selected: Span | null = null;
  let displayRows: HistoryRow[] = [];
  let shownPages = 1;
  let exploring = false;

  const box = document.createElement("div");
  box.className = "wr";

  const controls = document.createElement("div");
  controls.className = "wr-controls";

  const mkButton = (label: string, text: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.setAttribute("aria-label", label);
    b.className = "wr-btn";
    return b;
  };

  const btnFirst = mkButton("First edit", "⏮");
  const btnPrev = mkButton("Previous edit", "◀");
  const btnPlay = mkButton("Play", "▶");
  btnPlay.classList.add("wr-play");
  const btnNext = mkButton("Next edit", "▶");
  const btnFinal = mkButton("Final state", "⏭");
  const btnStart = mkButton("Watch from the beginning", "Watch from the beginning");
  btnStart.classList.add("wr-start");

  const speedWrap = document.createElement("span");
  speedWrap.className = "wr-speed";
  const speedLabel = document.createElement("span");
  speedLabel.textContent = "Speed";
  speedWrap.appendChild(speedLabel);
  for (const value of [1, 4, 16] as ReplaySpeed[]) {
    const lab = document.createElement("label");
    lab.className = "wr-speed-opt";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `wr-speed-${mountId}`;
    radio.value = String(value);
    radio.checked = value === 1;
    const caption = document.createElement("span");
    caption.textContent = `${value}×`;
    lab.append(radio, caption);
    on(radio, "change", () => {
      if (radio.checked) speed = value;
    });
    speedWrap.appendChild(lab);
  }

  const skipLabel = document.createElement("label");
  skipLabel.className = "wr-skip";
  const skipBox = document.createElement("input");
  skipBox.type = "checkbox";
  skipBox.checked = true;
  const skipCaption = document.createElement("span");
  skipCaption.textContent = "Skip long pauses";
  skipLabel.append(skipBox, skipCaption);
  on(skipBox, "change", () => {
    skipPauses = skipBox.checked;
  });

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(total);
  slider.step = "1";
  slider.value = String(position);
  slider.setAttribute("aria-label", "Replay position");
  slider.className = "wr-slider";

  const time = document.createElement("span");
  time.className = "wr-time";
  time.setAttribute("aria-hidden", "true");

  const status = document.createElement("div");
  status.className = "wr-status";
  status.setAttribute("aria-live", "polite");

  controls.append(btnFirst, btnPrev, btnPlay, btnNext, btnFinal, btnStart, speedWrap, skipLabel);

  const prose = document.createElement("div");
  prose.className = "wr-prose";
  if (!reduceMotion) prose.classList.add("wr-fade");

  const historyWrap = document.createElement("div");
  historyWrap.className = "wr-history";
  const exploreBtn = document.createElement("button");
  exploreBtn.type = "button";
  exploreBtn.textContent = "Explore sentence history";
  exploreBtn.className = "wr-btn";
  exploreBtn.setAttribute("aria-pressed", "false");
  const historyHead = document.createElement("h3");
  historyHead.textContent = "Sentence history";
  historyHead.className = "wr-history-head";
  const quote = document.createElement("div");
  quote.className = "wr-quote";
  const list = document.createElement("div");
  list.className = "wr-rows";
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.textContent = "Show earlier changes";
  moreBtn.className = "wr-btn";
  const emptyNote = document.createElement("p");
  emptyNote.className = "wr-empty";
  emptyNote.textContent = "Select a sentence to see its earlier versions.";
  historyWrap.append(exploreBtn, historyHead, quote, list, moreBtn, emptyNote);

  const cols = document.createElement("div");
  cols.className = "replay-cols";
  cols.append(prose, historyWrap);
  box.append(controls, slider, time, status, cols);
  root.appendChild(box);

  const announce = (message: string): void => {
    status.textContent = message;
  };

  const renderText = (): string => seekText(recording, checkpoints, position);

  const setSliderText = (): void => {
    slider.value = String(position);
    slider.setAttribute(
      "aria-valuetext",
      `Edit ${position} of ${total}, ${formatTime(elapsedAt(recording, position))}`,
    );
  };

  const renderSentences = (): void => {
    prose.innerHTML = "";
    const text = renderText();
    if (text === "") {
      const blank = document.createElement("p");
      blank.textContent = "Write something to begin";
      blank.className = "wr-blank";
      prose.appendChild(blank);
      return;
    }
    for (const span of sentenceSpans(text)) {
      const s = document.createElement("span");
      s.textContent = text.slice(span.start, span.end);
      s.className = "wr-sent";
      s.tabIndex = exploring ? 0 : -1;
      if (selected && span.start === selected.start && span.end === selected.end) {
        s.classList.add("wr-selected");
      }
      s.addEventListener(
        "click",
        () => {
          if (playing) pause();
          select(span);
        },
        { signal: ctl.signal },
      );
      prose.appendChild(s);
    }
  };

  const renderPlain = (): void => {
    prose.innerHTML = "";
    const text = renderText();
    if (text === "") {
      const blank = document.createElement("p");
      blank.textContent = "Write something to begin";
      blank.className = "wr-blank";
      prose.appendChild(blank);
      return;
    }
    const p = document.createElement("div");
    p.textContent = text;
    p.className = "wr-text";
    prose.appendChild(p);
  };

  const render = (): void => {
    if (playing) renderPlain();
    else renderSentences();
    setSliderText();
    time.textContent = `${formatTime(elapsedAt(recording, position))} / ${formatTime(elapsedAt(recording, total))}`;
    btnPlay.textContent = playing ? "⏸" : "▶";
    btnPlay.setAttribute("aria-label", playing ? "Pause" : "Play");
    const blank = total === 0;
    for (const b of [btnFirst, btnPrev, btnPlay, btnNext, btnFinal, btnStart]) b.disabled = blank;
    slider.disabled = blank;
  };

  const pause = (): void => {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(raf);
    render();
    announce(`Paused at edit ${position} of ${total}.`);
  };

  const tick = (now: number): void => {
    if (!playing) return;
    const dt = now - lastTick;
    lastTick = now;
    carry += dt;
    let advanced = false;
    while (position < total) {
      const need = effectiveGapMs(rawGapMs(recording, position + 1), speed, skipPauses);
      if (need > carry) break;
      carry -= need;
      position++;
      advanced = true;
      if (need <= 0) continue;
    }
    if (advanced && !reduceMotion) {
      prose.classList.add("wr-tick");
      requestAnimationFrame(() => prose.classList.remove("wr-tick"));
    }
    render();
    if (position >= total) {
      pause();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  const play = (): void => {
    if (playing || total === 0) return;
    if (position >= total) {
      position = 0;
      selected = null;
    }
    playing = true;
    carry = 0;
    lastTick = performance.now();
    render();
    announce(`Playing from edit ${position} of ${total}.`);
    raf = requestAnimationFrame(tick);
  };

  const seek = (seq: number): void => {
    pause();
    position = Math.max(0, Math.min(seq, total));
    render();
  };

  const renderHistory = (): void => {
    list.innerHTML = "";
    quote.textContent = "";
    const page = displayRows.slice(0, shownPages * HISTORY_PAGE);
    let shown = 0;
    for (const row of page) {
      if (row.relation === "unchanged") continue;
      if (row.relation === "introduced") {
        const marker = document.createElement("p");
        marker.className = "wr-introduced";
        marker.textContent = `Introduced here${row.seq > 0 ? ` (edit ${row.seq})` : ""}. No earlier text.`;
        list.appendChild(marker);
        shown++;
        continue;
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "wr-row";
      const passage = document.createElement("span");
      passage.className = "wr-row-text";
      passage.textContent = row.text;
      const meta = document.createElement("span");
      meta.className = "wr-row-meta";
      meta.textContent =
        `Edit ${row.seq} · ${formatTime(elapsedAt(recording, row.seq))}` +
        (RELABEL[row.relation] ? ` · ${RELABEL[row.relation]}` : "");
      item.append(passage, meta);
      const target = row.seq;
      item.addEventListener("click", () => seek(target), { signal: ctl.signal });
      list.appendChild(item);
      shown++;
    }
    const remaining = displayRows.filter((r) => r.relation !== "unchanged").length - shown;
    moreBtn.hidden = remaining <= 0;
    moreBtn.textContent = remaining > 0 ? `Show earlier changes (${remaining} more)` : "Show earlier changes";
    emptyNote.hidden = shown > 0;
    if (shown === 0 && selected) emptyNote.textContent = "No earlier version of this passage.";
  };

  const select = (span: Span): void => {
    selected = span;
    shownPages = 1;
    const text = renderText();
    quote.textContent = text.slice(
      Math.max(0, span.start),
      Math.min(span.end, text.length),
    );
    displayRows = coalesceRows(historyForSpan(recording, position, span));
    renderSentences();
    renderHistory();
  };

  const setExploring = (value: boolean): void => {
    exploring = value;
    exploreBtn.setAttribute("aria-pressed", String(value));
    box.classList.toggle("wr-exploring", value);
    renderSentences();
    if (value) {
      const first = prose.querySelector<HTMLElement>(".wr-sent");
      first?.focus();
      announce("Exploring sentences. Use arrow keys, Enter to select, Escape to exit.");
    } else {
      exploreBtn.focus();
    }
  };

  on(btnPlay, "click", () => (playing ? pause() : play()));
  on(btnFirst, "click", () => seek(0));
  on(btnFinal, "click", () => seek(total));
  on(btnPrev, "click", () => seek(position - 1));
  on(btnNext, "click", () => seek(position + 1));
  on(btnStart, "click", () => {
    seek(0);
    play();
  });
  on(slider, "input", () => seek(Number(slider.value)));
  on(moreBtn, "click", () => {
    shownPages++;
    renderHistory();
  });
  on(exploreBtn, "click", () => setExploring(!exploring));
  on(prose, "keydown", (e) => {
    if (!exploring) return;
    const key = (e as KeyboardEvent).key;
    const items = [...prose.querySelectorAll<HTMLElement>(".wr-sent")];
    const active = document.activeElement as HTMLElement | null;
    const at = items.indexOf(active ?? document.createElement("span"));
    if (key === "Escape") {
      (e as KeyboardEvent).preventDefault();
      setExploring(false);
    } else if (key === "ArrowRight" || key === "ArrowDown") {
      (e as KeyboardEvent).preventDefault();
      items[Math.min(items.length - 1, at + 1)]?.focus();
    } else if (key === "ArrowLeft" || key === "ArrowUp") {
      (e as KeyboardEvent).preventDefault();
      items[Math.max(0, at - 1)]?.focus();
    } else if (key === "Enter") {
      const focused = document.activeElement;
      const idx = items.indexOf(focused as HTMLElement);
      if (idx >= 0) {
        (e as KeyboardEvent).preventDefault();
        const spans = sentenceSpans(renderText());
        if (spans[idx]) {
          if (playing) pause();
          select(spans[idx]!);
        }
      }
    }
  });
  on(document, "visibilitychange", () => {
    if (document.hidden) pause();
  });

  render();
  renderHistory();
  return () => {
    ctl.abort();
    cancelAnimationFrame(raf);
    playing = false;
    box.remove();
  };
}
