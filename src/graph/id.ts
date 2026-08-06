// Deterministic id generation: pick the smallest positive integer N
// such that `${prefix}${N}` isn't already used. Pure function — caller
// supplies the set of in-use ids; we never read state ourselves.

// `from` lets a caller resume the probe where its last mint for this
// prefix stopped instead of restarting at 1. Only valid while no id
// has been FREED since that mint (nothing below the cursor can have
// become available), which is the guarantee editor/uid.ts maintains.
export const nextUid = (
  prefix: string,
  used: ReadonlySet<string>,
  from = 1,
): string => {
  let n = from;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

// Convenience: collect all ids that share a `prefix + integer` shape
// from any number of arrays of objects with an `.id` field. Used by
// the editor to feed nextUid() — boxes, texts, lines, strokes all
// pull from the same id namespace per map.
export const collectIds = (
  ...sources: ReadonlyArray<ReadonlyArray<{ readonly id: string }>>
): Set<string> => {
  const out = new Set<string>();
  for (const arr of sources) {
    for (const item of arr) out.add(item.id);
  }
  return out;
};
