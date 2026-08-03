// Content-script entry point. Deliberately thin — all the interesting
// logic (block detection, rendering, settings) lives in separate,
// jsdom-testable modules; this file only wires them together against
// the real page.
import { detectFlowgoBlocks } from "./detect.ts";
import { renderBlock, revertBlock } from "./render.ts";
import { isEnabled, onEnabledChanged } from "./settings.ts";

// chatgpt.com and claude.ai (this extension's two named target sites,
// per brain#217) stream a response in token-by-token, re-rendering
// the message DOM repeatedly while it's still arriving. Rendering on
// every mutation would flicker and waste work re-parsing a
// half-finished .flowgo block — instead each detected block gets a
// short "has this gone quiet?" debounce, reset on every further
// mutation, before it's actually rendered.
const STABLE_MS = 400;

let enabled = true;
const rendered = new Set<HTMLElement>();
const pendingTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function scheduleRender(container: HTMLElement): void {
  const existing = pendingTimers.get(container);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(container);
    if (!enabled || !container.isConnected) return;
    renderBlock(container);
    rendered.add(container);
  }, STABLE_MS);
  pendingTimers.set(container, timer);
}

function scan(root: ParentNode): void {
  if (!enabled) return;
  for (const el of detectFlowgoBlocks(root)) scheduleRender(el);
}

function revertAll(): void {
  for (const el of rendered) revertBlock(el);
  rendered.clear();
}

async function init(): Promise<void> {
  enabled = await isEnabled();

  onEnabledChanged((next) => {
    enabled = next;
    if (!enabled) revertAll();
    else scan(document.body);
  });

  if (enabled) scan(document.body);

  const observer = new MutationObserver((mutations) => {
    if (!enabled) return;
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLElement) scan(node);
      }
      if (mutation.type === "characterData") {
        const parent = mutation.target.parentElement;
        if (parent) scan(parent);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

init().catch((err) => console.error("[flowgo] content script init failed:", err));
