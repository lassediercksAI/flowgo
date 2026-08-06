// Fixture sanity + on-demand .flowgo stress-file writer.
//
// `just perf-fixture out=stress.flowgo boxes=3400` sets
// FLOWGO_PERF_FIXTURE_OUT and runs this file, producing a real
// .flowgo file you can open with the flowgo binary for in-browser
// profiling (devtools Performance tab / longtask observation) —
// the machine-dependent half the CI smoke deliberately skips.

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { serializeGraph } from "../../graph/serialize.ts";
import { parseFlowgo } from "../../graph/parse.ts";
import { makeStressGraph } from "./fixture.ts";

const out = process.env["FLOWGO_PERF_FIXTURE_OUT"];

describe("stress fixture", () => {
  it("is deterministic — same size, byte-identical .flowgo", () => {
    expect(serializeGraph(makeStressGraph(50))).toBe(
      serializeGraph(makeStressGraph(50)),
    );
  });

  it("round-trips through the .flowgo parser", () => {
    const g = makeStressGraph(50);
    const parsed = parseFlowgo(serializeGraph(g));
    expect(parsed.maps?.[0]?.boxes?.length).toBe(50);
    expect(parsed.maps?.[0]?.lines?.length).toBe(g.maps[0]!.lines.length);
  });

  it("fixed-frame variant differs only in the frame (brain#258)", () => {
    const plain = makeStressGraph(40).maps[0]!;
    const shaped = makeStressGraph(40, { fixedFrame: true }).maps[0]!;
    // Same seed consumption ⇒ identical geometry everywhere else.
    expect(shaped.lines).toEqual(plain.lines);
    expect(shaped.texts).toEqual(plain.texts);
    expect(shaped.strokes).toEqual(plain.strokes);
    expect(shaped.edges).toEqual(plain.edges);
    expect(shaped.boxes.map((b) => [b.id, b.x, b.y, b.palette]))
      .toEqual(plain.boxes.map((b) => [b.id, b.x, b.y, b.palette]));
    expect(plain.boxes.every((b) => !b.shape && !b.w)).toBe(true);
    // All four fixed-frame paths present, in equal quarters.
    expect(shaped.boxes.filter((b) => b.shape === 1).length).toBe(10);
    expect(shaped.boxes.filter((b) => b.shape === 2).length).toBe(10);
    expect(shaped.boxes.filter((b) => b.shape === 3).length).toBe(10);
    expect(shaped.boxes.filter((b) => b.w && b.h).length).toBe(10);
    // ...and survives the .flowgo round-trip (nodeshape / nodesize).
    const back = parseFlowgo(serializeGraph(makeStressGraph(40, { fixedFrame: true })));
    const rb = back.maps![0]!.boxes!;
    expect(rb.filter((b) => b.shape === 1).length).toBe(10);
    expect(rb.filter((b) => b.shape === 3).length).toBe(10);
    expect(rb.filter((b) => b.w && b.h).length).toBe(10);
  });

  it.runIf(out)("writes the stress map to FLOWGO_PERF_FIXTURE_OUT", () => {
    const n = Number(process.env["FLOWGO_PERF_FIXTURE_BOXES"] ?? "3400");
    const fixedFrame = process.env["FLOWGO_PERF_FIXTURE_SHAPED"] === "1";
    const text = serializeGraph(makeStressGraph(n, { fixedFrame }));
    writeFileSync(out!, text);
    console.log(
      `wrote ${out} (${n} boxes${fixedFrame ? ", fixed-frame" : ""}, `
      + `${text.length.toLocaleString("en-US")} bytes)`,
    );
  });
});
