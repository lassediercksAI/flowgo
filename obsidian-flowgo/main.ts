import { Plugin } from "obsidian";

import { renderFlowgoBlock } from "./src/render.ts";

// Renders ```flowgo fenced code blocks as read-only flowgo mind-maps in
// reading view / preview. Live Preview and the source editor still show
// the raw fenced block while editing — that's Obsidian's normal default
// for code-block languages without a CodeMirror extension registered,
// and is intentional here: this plugin does not support in-place
// editing of a flowgo map (brain#216 scoped that to VS Code's and
// remark/rehype's counterparts; use the flowgo app itself to edit).
export default class FlowgoPlugin extends Plugin {
  override async onload(): Promise<void> {
    this.registerMarkdownCodeBlockProcessor("flowgo", (source, el) => {
      renderFlowgoBlock(el, source);
    });
  }
}
