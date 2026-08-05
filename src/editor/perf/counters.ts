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
  };

  const origCreate = document.createElement.bind(document);
  const origCreateNS = document.createElementNS.bind(document);
  const elemProto = Element.prototype;
  const origQS = elemProto.querySelector;
  const origQSA = elemProto.querySelectorAll;
  const tokenProto = DOMTokenList.prototype;
  const origToggle = tokenProto.toggle;

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
  tokenProto.toggle = function (this: DOMTokenList, ...args: [string, boolean?]) {
    counters.classToggles++;
    return origToggle.apply(this, args);
  };

  return {
    counters,
    reset: () => {
      counters.elementsCreated = 0;
      counters.domQueries = 0;
      counters.classToggles = 0;
    },
    uninstall: () => {
      document.createElement = origCreate;
      document.createElementNS = origCreateNS;
      elemProto.querySelector = origQS;
      elemProto.querySelectorAll = origQSA;
      tokenProto.toggle = origToggle;
    },
  };
};
