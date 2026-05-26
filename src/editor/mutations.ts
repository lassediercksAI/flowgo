// Chokepoint for "the live graph just mutated; persist." Every
// mutation seam in the editor calls one of the typed mutator
// functions below instead of scheduleSave() directly.
//
// Today every mutator funnels into the wired scheduleSave —
// behaviour is identical to calling scheduleSave() at the call site.
// The typed surface exists so that downstream wiring can hook on
// the right kind of change without a 30-site audit later.

interface MutationBindings {
  readonly scheduleSave: () => void;
}

let bindings: MutationBindings | null = null;

export const wireMutations = (b: MutationBindings): void => {
  bindings = b;
};

const fire = (): void => {
  if (!bindings) throw new Error("mutations: wireMutations() not called");
  bindings.scheduleSave();
};

// One function per kind on the current map. The function shapes
// reserve room for downstream wiring that wants to scope a diff to
// a specific entity; today they all just fire scheduleSave.

export const mutatedBox = (): void => fire();
export const mutatedEdge = (): void => fire();
export const mutatedText = (): void => fire();
export const mutatedLine = (): void => fire();
export const mutatedStroke = (): void => fire();

// The current map changed in a way that spans multiple kinds or
// touches the whole map (paste, align, multi-select palette change).
export const mutatedCurrentMap = (): void => fire();

// The document structure changed (maps added/removed via box
// deletion, or anything that affects more than one map at once).
export const mutatedDoc = (): void => fire();
