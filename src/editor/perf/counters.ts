// DOM-operation counters for the perf smoke benchmark.
//
// Wall-clock time on shared CI runners is noise, so the benchmark's
// ASSERTIONS run on machine-independent operation counts instead:
// how many elements a render creates, how many selector queries an
// interaction issues, how many class toggles a selection change
// costs. Those numbers are identical on every machine for the same
// code + fixture, which makes them safe to gate CI on.
//
// install() monkey-patches the jsdom DOM entry points the editor's
// render path goes through and counts calls; uninstall() restores
// the originals. Counting is call-based, not node-visit-based — a
// querySelector over a 20k-node document counts as 1 query — so the
// counters measure "how often does the code reach into the DOM",
// which is exactly the O(boxes × DOM) shape brain #236 is about.

export interface DomCounters {
  /** document.createElement + createElementNS calls. */
  elementsCreated: number;
  /** Element.querySelector / querySelectorAll calls (scoped lookups). */
  domQueries: number;
  /** classList.toggle calls (the applyClasses write primitive). */
  classToggles: number;
  /** Element.setAttribute calls (the SVG geometry write primitive —
   *  what an edge re-route or line update costs, #238). */
  attrSets: number;
  /** getComputedStyle calls (the label-clamp style read, #258). */
  styleReads: number;
  /**
   * Reads that a real browser has to service by flushing pending
   * style + layout work — i.e. FORCED REFLOWS (brain#258).
   *
   * Counted as: a geometry/style read (`getComputedStyle`,
   * `clientHeight/Width`, `offsetWidth/Height`,
   * `getBoundingClientRect`) issued while the DOM is dirty, where
   * "dirty" is set by any structural or style write (insert, remove,
   * setAttribute, class toggle, inline custom-property write) and
   * cleared by the read that flushes it.
   *
   * jsdom does no layout, so this is a MODEL of the browser's
   * invalidation, not a measurement of it — but it is exact about
   * the thing that matters: whether reads are interleaved with
   * writes (N flushes) or batched after them (1 flush). That is the
   * whole of brain#258, and it is machine-independent.
   */
  forcedReflows: number;
}

export interface CounterHandle {
  readonly counters: DomCounters;
  readonly reset: () => void;
  readonly uninstall: () => void;
}

export const installCounters = (): CounterHandle => {
  const counters: DomCounters = {
    elementsCreated: 0,
    domQueries: 0,
    classToggles: 0,
    attrSets: 0,
    styleReads: 0,
    forcedReflows: 0,
  };

  // Layout-invalidation model — see DomCounters.forcedReflows.
  let dirty = false;
  // Depth of the currently-executing patched READ. jsdom builds the
  // declaration `getComputedStyle` returns by calling `setProperty`
  // on it several dozen times — internals of a read, not writes by
  // the code under test, and billing them would make every read after
  // the first look like a fresh flush. Writes issued inside a read
  // are therefore ignored.
  let inRead = 0;
  const markDirty = (): void => {
    if (inRead === 0) dirty = true;
  };
  // Wrap a read so it (a) settles any pending invalidation, charging
  // one forced reflow for it, and (b) doesn't bill its own internals.
  const read = <T>(fn: () => T): T => {
    if (dirty && inRead === 0) {
      counters.forcedReflows++;
      dirty = false;
    }
    inRead++;
    try {
      return fn();
    } finally {
      inRead--;
    }
  };
  // Restores queued by patchLayoutGetter, replayed by uninstall() in
  // reverse so nested patches unwind cleanly.
  const restores: Array<() => void> = [];

  // Patch a getter that a browser can only answer from fresh layout.
  // Guarded: an engine that doesn't expose the property, or exposes
  // it non-configurably, just doesn't get counted.
  const patchLayoutGetter = (proto: object, prop: string): void => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d?.get || d.configurable === false) return;
    const orig = d.get;
    Object.defineProperty(proto, prop, {
      ...d,
      get: function (this: unknown) {
        return read(() => orig.call(this));
      },
    });
    restores.push(() => Object.defineProperty(proto, prop, d));
  };

  const origCreate = document.createElement.bind(document);
  const origCreateNS = document.createElementNS.bind(document);
  const elemProto = Element.prototype;
  const origQS = elemProto.querySelector;
  const origQSA = elemProto.querySelectorAll;
  const origSetAttr = elemProto.setAttribute;
  const tokenProto = DOMTokenList.prototype;
  const origToggle = tokenProto.toggle;
  const origAdd = tokenProto.add;
  const origRemove = tokenProto.remove;
  const nodeProto = Node.prototype;
  const origInsertBefore = nodeProto.insertBefore;
  const origAppendChild = nodeProto.appendChild;
  const origRemoveChild = nodeProto.removeChild;
  const cssProto = CSSStyleDeclaration.prototype;
  const origSetProperty = cssProto.setProperty;
  const origGetComputedStyle = window.getComputedStyle.bind(window);
  const origGetRect = elemProto.getBoundingClientRect;

  document.createElement = ((...args: Parameters<Document["createElement"]>) => {
    counters.elementsCreated++;
    return origCreate(...args);
  }) as Document["createElement"];
  document.createElementNS = ((...args: unknown[]) => {
    counters.elementsCreated++;
    return (origCreateNS as (...a: unknown[]) => Element)(...args);
  }) as Document["createElementNS"];
  elemProto.querySelector = function (this: Element, ...args: [string]) {
    counters.domQueries++;
    return origQS.apply(this, args);
  } as Element["querySelector"];
  elemProto.querySelectorAll = function (this: Element, ...args: [string]) {
    counters.domQueries++;
    return origQSA.apply(this, args);
  } as Element["querySelectorAll"];
  elemProto.setAttribute = function (this: Element, ...args: [string, string]) {
    counters.attrSets++;
    markDirty();
    return origSetAttr.apply(this, args);
  };
  tokenProto.toggle = function (this: DOMTokenList, ...args: [string, boolean?]) {
    counters.classToggles++;
    markDirty();
    return origToggle.apply(this, args);
  };

  // ── Writes that invalidate style/layout (#258) ──
  tokenProto.add = function (this: DOMTokenList, ...args: string[]) {
    markDirty();
    return origAdd.apply(this, args);
  };
  tokenProto.remove = function (this: DOMTokenList, ...args: string[]) {
    markDirty();
    return origRemove.apply(this, args);
  };
  nodeProto.insertBefore = function (this: Node, ...args: [Node, Node | null]) {
    markDirty();
    return origInsertBefore.apply(this, args);
  } as Node["insertBefore"];
  nodeProto.appendChild = function (this: Node, ...args: [Node]) {
    markDirty();
    return origAppendChild.apply(this, args);
  } as Node["appendChild"];
  nodeProto.removeChild = function (this: Node, ...args: [Node]) {
    markDirty();
    return origRemoveChild.apply(this, args);
  } as Node["removeChild"];
  cssProto.setProperty = function (
    this: CSSStyleDeclaration,
    ...args: [string, string | null, string?]
  ) {
    markDirty();
    return origSetProperty.apply(this, args);
  };

  // ── Reads a browser can only answer from fresh style/layout ──
  window.getComputedStyle = ((...args: [Element, string?]) => {
    counters.styleReads++;
    return read(() => origGetComputedStyle(...args));
  }) as typeof window.getComputedStyle;
  elemProto.getBoundingClientRect = function (this: Element) {
    return read(() => origGetRect.call(this));
  };
  for (const p of ["clientHeight", "clientWidth"]) patchLayoutGetter(elemProto, p);
  for (const p of ["offsetHeight", "offsetWidth", "offsetTop", "offsetLeft"]) {
    patchLayoutGetter(HTMLElement.prototype, p);
  }

  return {
    counters,
    reset: () => {
      counters.elementsCreated = 0;
      counters.domQueries = 0;
      counters.classToggles = 0;
      counters.attrSets = 0;
      counters.styleReads = 0;
      counters.forcedReflows = 0;
      // A reset starts a fresh measurement window; carrying the dirty
      // flag over would bill the previous phase's writes to this one.
      dirty = false;
      inRead = 0;
    },
    uninstall: () => {
      document.createElement = origCreate;
      document.createElementNS = origCreateNS;
      elemProto.querySelector = origQS;
      elemProto.querySelectorAll = origQSA;
      elemProto.setAttribute = origSetAttr;
      elemProto.getBoundingClientRect = origGetRect;
      tokenProto.toggle = origToggle;
      tokenProto.add = origAdd;
      tokenProto.remove = origRemove;
      nodeProto.insertBefore = origInsertBefore;
      nodeProto.appendChild = origAppendChild;
      nodeProto.removeChild = origRemoveChild;
      cssProto.setProperty = origSetProperty;
      window.getComputedStyle = origGetComputedStyle as typeof window.getComputedStyle;
      for (let i = restores.length - 1; i >= 0; i--) restores[i]!();
    },
  };
};
