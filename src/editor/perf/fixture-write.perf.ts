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

  it.runIf(out)("writes the stress map to FLOWGO_PERF_FIXTURE_OUT", () => {
    const n = Number(process.env["FLOWGO_PERF_FIXTURE_BOXES"] ?? "3400");
    const text = serializeGraph(makeStressGraph(n));
    writeFileSync(out!, text);
    console.log(`wrote ${out} (${n} boxes, ${text.length.toLocaleString("en-US")} bytes)`);
  });
});
