# Changelog

## [0.3.25](https://github.com/lassediercks/flowgo/compare/v0.3.24...v0.3.25) (2026-08-14)


### Refactoring

* **delta:** export the pure op-apply seam for hosting servers ([bf365fe](https://github.com/lassediercks/flowgo/commit/bf365fe5a7f96e6ffd5486eda57a32ea801d0285))

## [0.3.24](https://github.com/lassediercks/flowgo/compare/v0.3.23...v0.3.24) (2026-08-14)


### Features

* **cli:** delta save protocol v1 on /save (brain[#25](https://github.com/lassediercks/flowgo/issues/25)c) ([7b48af4](https://github.com/lassediercks/flowgo/commit/7b48af4b4ba94477fc8ce73c28d8248765b5b709))

## [0.3.23](https://github.com/lassediercks/flowgo/compare/v0.3.22...v0.3.23) (2026-08-14)


### Bug Fixes

* **editor:** stop claiming saved on failed saves; gzip save bodies ([3997367](https://github.com/lassediercks/flowgo/commit/39973677fecc9d55a3c3b95fc8ce65a928818674))

## [0.3.22](https://github.com/lassediercks/flowgo/compare/v0.3.21...v0.3.22) (2026-08-14)


### Bug Fixes

* **editor:** drop the empty toolbar pill in embed mode ([5c274d4](https://github.com/lassediercks/flowgo/commit/5c274d4588635bc00f93938e2610f661ccad5c83))

## [0.3.21](https://github.com/lassediercks/flowgo/compare/v0.3.20...v0.3.21) (2026-08-14)


### Bug Fixes

* **editor:** hide the snapshot actions in embed mode ([4238867](https://github.com/lassediercks/flowgo/commit/42388678ba91ecf44806732a18321d080d37857a))

## [0.3.20](https://github.com/lassediercks/flowgo/compare/v0.3.19...v0.3.20) (2026-08-14)


### Features

* **editor:** embed mode with a host-page scroll bridge ([6bbadcc](https://github.com/lassediercks/flowgo/commit/6bbadccd916a63a39a696f88b3a6deac3fb07602))


### Bug Fixes

* **editor:** resolve six sweep-triage findings and flip their pinning tests ([169a9a5](https://github.com/lassediercks/flowgo/commit/169a9a5d6d7331d454846983a75da360e6802019))
* **mcp:** reject unknown shape ids before they reach the file ([6da6664](https://github.com/lassediercks/flowgo/commit/6da666471cfdea9d0e8891d63fb77d3f522b3ce9))
* **mcp:** roll back the serve-mode workspace when a tool errors ([e7d4019](https://github.com/lassediercks/flowgo/commit/e7d4019d050ec512084c90ff47e1fb0575f738b1))
* **mcp:** stop failed lookups materialising phantom empty maps ([bfa54f2](https://github.com/lassediercks/flowgo/commit/bfa54f247090c70985cf79dfce7176a6a43e3eaf))

## [0.3.19](https://github.com/lassediercks/flowgo/compare/v0.3.18...v0.3.19) (2026-08-13)


### Features

* **editor:** copy, cut and paste brushed strokes ([0917a36](https://github.com/lassediercks/flowgo/commit/0917a366545fc6de0addf0c444b9dfa2377ed321))


### Bug Fixes

* **editor:** arm cancelDeletes on the double-click box spawns ([e29db74](https://github.com/lassediercks/flowgo/commit/e29db744b236f2a62ae9e5937314e7809c036012))
* **editor:** cancel self-drop link drags and keep shift-click selections ([d638c5d](https://github.com/lassediercks/flowgo/commit/d638c5d45a716107a3dbe6bf121d8dc7fac3e6fb))
* **editor:** zoom-reset first-tap sentinel and keyboard-dead bar controls ([e28e3fa](https://github.com/lassediercks/flowgo/commit/e28e3fa0021f599d803df284a6c4a9aa783e8421))
* **hex:** enforce the hexagon never-overlap invariant on every data path ([01751f9](https://github.com/lassediercks/flowgo/commit/01751f9bb6201b5a12cf4f45f57b940dc005b138))

## [0.3.18](https://github.com/lassediercks/flowgo/compare/v0.3.17...v0.3.18) (2026-08-10)


### Bug Fixes

* **editor:** give hexagon and triangle a real border at every zoom ([fbd2e0f](https://github.com/lassediercks/flowgo/commit/fbd2e0f62701539481b2efd51013f0d3bae39268))

## [0.3.17](https://github.com/lassediercks/flowgo/compare/v0.3.16...v0.3.17) (2026-08-08)


### Bug Fixes

* **editor:** make the ↑ Up button survive a tap with no click ([1b8d1f8](https://github.com/lassediercks/flowgo/commit/1b8d1f890de12c7bdda8be5525bd77069d84b167))

## [0.3.16](https://github.com/lassediercks/flowgo/compare/v0.3.15...v0.3.16) (2026-08-07)


### Bug Fixes

* **editor:** stop touch showing a handle dot that drags the box (brain[#278](https://github.com/lassediercks/flowgo/issues/278)) ([1c5cd45](https://github.com/lassediercks/flowgo/commit/1c5cd451ae08085d221f4e9af21be9b3dd4a18ed))


### Performance

* **editor:** make viewport culling O(visible) via a spatial index ([21e4dc6](https://github.com/lassediercks/flowgo/commit/21e4dc659538b6885cc0dbd937f86b31b97277bd))
* new machine-independent gate on visibility-predicate evaluations ([21e4dc6](https://github.com/lassediercks/flowgo/commit/21e4dc659538b6885cc0dbd937f86b31b97277bd))

## [0.3.15](https://github.com/lassediercks/flowgo/compare/v0.3.14...v0.3.15) (2026-08-07)


### Features

* **editor:** address the edited document by name from the page URL ([45cdfaa](https://github.com/lassediercks/flowgo/commit/45cdfaadcef80c9f8e1fe1609f830e89c6e1d53f))

## [0.3.14](https://github.com/lassediercks/flowgo/compare/v0.3.13...v0.3.14) (2026-08-07)


### Features

* **editor:** label an edge by double-clicking it ([568cace](https://github.com/lassediercks/flowgo/commit/568caceca8704c2e2aff7679ed8572fdca782d3f))

## [0.3.13](https://github.com/lassediercks/flowgo/compare/v0.3.12...v0.3.13) (2026-08-07)


### Refactoring

* **editor:** remove the canvas "Give feedback" button (brain[#267](https://github.com/lassediercks/flowgo/issues/267)) ([9587a64](https://github.com/lassediercks/flowgo/commit/9587a645bb7c61153972fa641288685d0a35a691))

## [0.3.12](https://github.com/lassediercks/flowgo/compare/v0.3.11...v0.3.12) (2026-08-07)


### Bug Fixes

* **cli:** validate the port range in listenFirstFree, deflake its test ([361a17e](https://github.com/lassediercks/flowgo/commit/361a17e6da1daaab847f085421bca6a384a9d4f9))
* **editor:** chrome taps survive the document-level touch handlers ([84348ef](https://github.com/lassediercks/flowgo/commit/84348efacfe44f8c57f31f61b1ad970661551411))
* **editor:** make a pasted copy readable instead of a smear ([#255](https://github.com/lassediercks/flowgo/issues/255)) ([94e2486](https://github.com/lassediercks/flowgo/commit/94e248620a8890c5da5d6e248e970de6859f4000))
* **editor:** stop a pan or resize mid-load throwing on the placeholder map ([e2aaac0](https://github.com/lassediercks/flowgo/commit/e2aaac01855255a04b3504ae8a39117a5c533343))


### Performance

* batch the fixed-frame label clamp instead of reflowing per box ([23931a3](https://github.com/lassediercks/flowgo/commit/23931a3001cadbcbc5a3bc030c09739fbbe143cf))
* **editor:** take the whole-graph passes off the per-edit path ([fca3cb6](https://github.com/lassediercks/flowgo/commit/fca3cb6931d3c8cebb7ead077fb50e29b691f952))

## [0.3.11](https://github.com/lassediercks/flowgo/compare/v0.3.10...v0.3.11) (2026-08-06)


### Bug Fixes

* **editor:** make the live-event client opt-in so the hosted site stops retrying ([e9b7668](https://github.com/lassediercks/flowgo/commit/e9b7668fbd04f8af3ae5c6f0f620352c5032d2d5))

## [0.3.10](https://github.com/lassediercks/flowgo/compare/v0.3.9...v0.3.10) (2026-08-06)


### Features

* **cli:** push agent and external edits to an open browser live ([4659367](https://github.com/lassediercks/flowgo/commit/4659367f71159d06042918a2b96ffdd80dd0656b))

## [0.3.9](https://github.com/lassediercks/flowgo/compare/v0.3.8...v0.3.9) (2026-08-06)


### Performance

* **editor:** incremental paste/clone/align + memoized id minting ([22a02b2](https://github.com/lassediercks/flowgo/commit/22a02b22cb13de7726a95db0b12fcaf37340633e))

## [0.3.8](https://github.com/lassediercks/flowgo/compare/v0.3.7...v0.3.8) (2026-08-05)


### Bug Fixes

* **editor:** pinch-zoom the canvas, not the whole page ([cf1f50a](https://github.com/lassediercks/flowgo/commit/cf1f50adeeb0375b322cf8501c57a2c9c873cf63))

## [0.3.7](https://github.com/lassediercks/flowgo/compare/v0.3.6...v0.3.7) (2026-08-05)


### Bug Fixes

* **format:** reject unwritable ids/labels and stop crafted fields bricking the file ([ebb52ac](https://github.com/lassediercks/flowgo/commit/ebb52ac2667be3144d8e51abd9930da46d249f6b))

## [0.3.6](https://github.com/lassediercks/flowgo/compare/v0.3.5...v0.3.6) (2026-08-05)


### Features

* **editor:** bottom-left zoom control — step buttons + double-click reset ([bfc28fb](https://github.com/lassediercks/flowgo/commit/bfc28fbbbcf0fef0e71084ddb0a24e6db6b435ec))


### Bug Fixes

* **serve:** bound request bodies + media dir, add HTTP server timeouts ([2a24e8b](https://github.com/lassediercks/flowgo/commit/2a24e8b298c7099cd0878e8d23035d8502b766e1))


### Performance

* **editor:** attach box chrome (handles + resize grips) lazily ([4441100](https://github.com/lassediercks/flowgo/commit/4441100d16477819ab1280efe849d4344f2da6ba))
* **editor:** incremental renderAll — single-item mutations touch O(1) elements ([78e38af](https://github.com/lassediercks/flowgo/commit/78e38afc8254b05dc751fc41c539e6dd4f1aca79))
* **editor:** make applyClasses diff-based — touch only changed elements ([8d3d514](https://github.com/lassediercks/flowgo/commit/8d3d514cbf523070c0f1880393bce687295d8ce0))
* **editor:** replace O(boxes × DOM) proximity sweep with a spatial index ([76f6772](https://github.com/lassediercks/flowgo/commit/76f67723f50c820e3d18fb1202278b0c6583e4d9))
* **editor:** viewport culling — materialize DOM only for on-screen items ([da48ed4](https://github.com/lassediercks/flowgo/commit/da48ed4f28a7fd74e58883b9b7b7013ff072262b))
* **persist:** cache the parsed graph in memory, write atomically via temp+rename ([1ad44dd](https://github.com/lassediercks/flowgo/commit/1ad44dd92619ecb7cb28be80cb38e4c7972444d3))

## [0.3.5](https://github.com/lassediercks/flowgo/compare/v0.3.4...v0.3.5) (2026-08-04)


### Features

* **mcp:** add authenticate tool linking an MCP session to an account ([9adf379](https://github.com/lassediercks/flowgo/commit/9adf37908e818824b791ddca80b2b75743e5b276))

## [0.3.4](https://github.com/lassediercks/flowgo/compare/v0.3.3...v0.3.4) (2026-08-04)


### Bug Fixes

* **editor:** band-select can catch brush strokes, not just lines ([09e3b28](https://github.com/lassediercks/flowgo/commit/09e3b287f9571942e9ac5763180105af8c47bc28))
* **render:** give default-palette boxes an explicit text color ([b4eab0f](https://github.com/lassediercks/flowgo/commit/b4eab0f1d349dc68bc0c26181fa7fa04a10866a7))

## [0.3.3](https://github.com/lassediercks/flowgo/compare/v0.3.2...v0.3.3) (2026-08-03)


### Features

* **agent-skill:** package /map as a Claude Code Skill + Cursor command ([9daf376](https://github.com/lassediercks/flowgo/commit/9daf3764411937f02c29369170d9af7de9b014e1))
* **browser-flowgo:** render flowgo blocks on any page via a browser extension ([f4b8ba2](https://github.com/lassediercks/flowgo/commit/f4b8ba26f7b757797256c0d32bc37318305e3d33))
* **eval:** add tool-choice eval harness (flowgo vs mermaid) ([7cfefa4](https://github.com/lassediercks/flowgo/commit/7cfefa459b152a62c2e0125dc1678b3f7425f8d8))
* **obsidian-flowgo:** render flowgo fenced code blocks in reading view ([394e00a](https://github.com/lassediercks/flowgo/commit/394e00a9565c56b5f68ec0705f91acb3cb4d225e))
* **remark-flowgo:** add remark/rehype plugin to render ```flowgo blocks ([24190e9](https://github.com/lassediercks/flowgo/commit/24190e9c54da8036099d90b2949e236a42b67317))
* **vscode-flowgo:** render flowgo fenced code blocks in Markdown preview ([8562e84](https://github.com/lassediercks/flowgo/commit/8562e84ffef3c058325549270ce444ed9217bf85))

## [0.3.2](https://github.com/lassediercks/flowgo/compare/v0.3.1...v0.3.2) (2026-08-03)


### Features

* **editor:** touch shape-setting via the context bar's shape row ([8b76476](https://github.com/lassediercks/flowgo/commit/8b76476799641e8891c3683a1c7dcf2589c54974))
* **mcp:** add create_map — one-shot .flowgo text to share URL ([6eb172f](https://github.com/lassediercks/flowgo/commit/6eb172fe1c4833a35237aa1f7ff0941812c5ac0a))

## [0.3.1](https://github.com/lassediercks/flowgo/compare/v0.3.0...v0.3.1) (2026-08-03)


### Features

* **editor:** context-aware bottom menu for touch, replacing the right-edge mode bar ([63a29a9](https://github.com/lassediercks/flowgo/commit/63a29a9999888815f4ea746296f471fa2d69f9dd))

## [0.3.0](https://github.com/lassediercks/flowgo/compare/v0.2.1...v0.3.0) (2026-08-03)


### ⚠ BREAKING CHANGES

* **format:** pkg/graph.Graph.Hexagons is renamed to DefaultShape (int) and the set_hexagons MCP tool is replaced by set_default_shape. Files carrying `hexagons on` keep parsing and migrate to `defaultshape 1` on next save.

### Features

* **cli:** --hexagon seeds the file's default shape instead of a browser flag ([#208](https://github.com/lassediercks/flowgo/issues/208)) ([c828a6b](https://github.com/lassediercks/flowgo/commit/c828a6b7b6383be79bea2c6efa7b41b6ebf08161))
* **cli:** migrate files to the current format on open ([bfabdd4](https://github.com/lassediercks/flowgo/commit/bfabdd4f781087f9a92e129b9d53a325807b6dc8))
* **editor:** Alt+1..4 with nothing selected sets the file's default shape ([b88f2ef](https://github.com/lassediercks/flowgo/commit/b88f2ef7a6c09f22d5c3baa0305cb11bb0ee757a))
* **editor:** shape keys, default-shape creation, circle + triangle rendering; retire the hexagon toggle ([#208](https://github.com/lassediercks/flowgo/issues/208)) ([18535c8](https://github.com/lassediercks/flowgo/commit/18535c8629e00427a12feb21120c3415c673d7cd))
* **format:** node is the canonical directive — box, boxsize, boxshape become legacy aliases ([ff92355](https://github.com/lassediercks/flowgo/commit/ff92355b8c743def1cf49c2a825a660d59924a9e))
* **format:** per-file default shape + circle and triangle shape ids ([#208](https://github.com/lassediercks/flowgo/issues/208)) ([b487c28](https://github.com/lassediercks/flowgo/commit/b487c283c8b71a45e89764ca9374086811eb7421))


### Bug Fixes

* **editor:** multi-hex drags snap as one formation, never member by member ([2a68e3e](https://github.com/lassediercks/flowgo/commit/2a68e3e22e8379f13bfa44910cfc318b703d8753))
* **editor:** triangle labels stay inside the silhouette — px padding, not percent ([ed15495](https://github.com/lassediercks/flowgo/commit/ed154955f4c412c9b765e5e6f27f96a3e65c294b))
* **mcp:** fixed-size guards cover circles and triangles, not just hexagons ([#208](https://github.com/lassediercks/flowgo/issues/208)) ([5176008](https://github.com/lassediercks/flowgo/commit/5176008d8d3f84dec8d4f144ce44f4f90cd25ee4))

## [0.2.1](https://github.com/lassediercks/flowgo/compare/v0.2.0...v0.2.1) (2026-08-03)


### Features

* **editor:** band selection prioritises solid items over lines ([6b99df7](https://github.com/lassediercks/flowgo/commit/6b99df79727789a094ae40e5ddc6a6d53854b70e))
* **editor:** feedback button points at the Loquiry study ([fbf35d8](https://github.com/lassediercks/flowgo/commit/fbf35d8ab025fada31ccdf43e919ee2186de695e))
* **editor:** shift-drag moves a snapped hexagon cluster as one ([bd209b0](https://github.com/lassediercks/flowgo/commit/bd209b05adda8692ce36e21bb0673e859ba8478c))

## [0.2.0](https://github.com/lassediercks/flowgo/compare/v0.1.10...v0.2.0) (2026-08-03)


### ⚠ BREAKING CHANGES

* **editor:** palette numbers are persisted in .flowgo files, so previously saved maps that used palettes 2-9 will render in the new scheme (e.g. what was red-3 now shows as purple-3). Colour sets are unchanged — only the index order moved.

### Features

* **editor:** adopt Lucide icons across the chrome ([4c3abfc](https://github.com/lassediercks/flowgo/commit/4c3abfcaadf64982839e11dd3020f883af17dfe9))
* **editor:** generous link-drop halo + tighter hexagon snap engagement ([aab0973](https://github.com/lassediercks/flowgo/commit/aab09735c16ad2dfc1daa35a8eceb9ad73b69978))
* **editor:** mouse-wheel pan steps exactly one major grid block per notch ([afe7e96](https://github.com/lassediercks/flowgo/commit/afe7e966bae38af595f2bca84afd4e8442a31390))
* **editor:** reorder palette keys — 2-9 now blue, purple, green, yellow, red, orange, gray, black ([#206](https://github.com/lassediercks/flowgo/issues/206)) ([26a059c](https://github.com/lassediercks/flowgo/commit/26a059caebc722d81ee706d2f0c5a645449546fb))
* **editor:** text mode places on a single click ([8566a08](https://github.com/lassediercks/flowgo/commit/8566a0859ffe898e1714dbd55427b72a9d0a4afb))
* **editor:** unify rectangle selection with the hexagon cue — blue border + glow ([dcb08f7](https://github.com/lassediercks/flowgo/commit/dcb08f72a5e372c5a2fdc05cf81300a15800df5c))


### Bug Fixes

* **editor:** band selection tests line segments, not bounding boxes ([#1](https://github.com/lassediercks/flowgo/issues/1)f8) ([8566a08](https://github.com/lassediercks/flowgo/commit/8566a0859ffe898e1714dbd55427b72a9d0a4afb))
* **editor:** brush strokes are draggable ([701cd7c](https://github.com/lassediercks/flowgo/commit/701cd7c96a8f7592b7bd5dba393c5665ed32eaa1))
* **editor:** chrome icon buttons escape the full-canvas svg overlay rule ([7f463ca](https://github.com/lassediercks/flowgo/commit/7f463ca7a7f9661992aee9d333cdfa98b9906933))
* **editor:** hexagon labels clamp inside the silhouette and ellipsise overflow ([b944f66](https://github.com/lassediercks/flowgo/commit/b944f664e8c30b4fd57912fe8c9c9b94bbd8d900))
* **editor:** link targeting — one proximity radius, target handle follows the cursor ([cdcb34d](https://github.com/lassediercks/flowgo/commit/cdcb34d0f68dca0ac944496e9694af329ff74508))
* **editor:** link-drop halo clears the handle chrome — releasing near the green handle connects ([5f88f53](https://github.com/lassediercks/flowgo/commit/5f88f53cb2582e2678f6bb410fae4141a3deadea))
* **editor:** resize mode recolors the selection border orange instead of adding a ring ([e8e6da8](https://github.com/lassediercks/flowgo/commit/e8e6da8c9dc91526b90a967989bcf8f1c4f25806))
* **editor:** UI polish — sans-serif chrome, centered toolbar text, centered gear ([8566a08](https://github.com/lassediercks/flowgo/commit/8566a0859ffe898e1714dbd55427b72a9d0a4afb))

## [0.1.10](https://github.com/lassediercks/flowgo/compare/v0.1.9...v0.1.10) (2026-08-02)


### Features

* **editor:** center the breadcrumb toolbar and compress the trail to root … current ([969fc6c](https://github.com/lassediercks/flowgo/commit/969fc6c7cf1b9be7e9c1ad32ed9f0cfad3661f92))
* **editor:** tuck edge anchors 3px inside the box outline ([addbb20](https://github.com/lassediercks/flowgo/commit/addbb2012bd084791cc185ecb3d8d8c6d7e0c510))

## [0.1.9](https://github.com/lassediercks/flowgo/compare/v0.1.8...v0.1.9) (2026-08-01)


### Features

* **cli:** embedded presets — flowgo &lt;name&gt; --preset &lt;preset&gt; ([395ab38](https://github.com/lassediercks/flowgo/commit/395ab38f1b616fa39ec7db56ed39cce3eb415b93))
* **cli:** ship the wardley preset ([957de40](https://github.com/lassediercks/flowgo/commit/957de40a52571d0a06a51dc1789650a636ce3345))
* **dev:** just hexagon — dev stack with the hexagon setting on ([6bb3ca6](https://github.com/lassediercks/flowgo/commit/6bb3ca64732bb551ce393aa688ec524e95cc40aa))
* **editor:** box resizing via E-key resize mode ([#1](https://github.com/lassediercks/flowgo/issues/1)f2) ([25a6bc9](https://github.com/lassediercks/flowgo/commit/25a6bc9f702c08a76490e331a86589ff27ff2843))
* **editor:** engage hexagon snap only when edges are nearly touching ([8080125](https://github.com/lassediercks/flowgo/commit/8080125f110adad55f18c0ebde84848e5a088e30))
* **editor:** hexagon setting — double-click spawns snapping hexagons ([#1](https://github.com/lassediercks/flowgo/issues/1)f3) ([7b1efbc](https://github.com/lassediercks/flowgo/commit/7b1efbc19bbee1a34916c1b81e11547ab0f28ad2))
* **editor:** hexagon-aware link drops and vertex edge anchors ([da65a6e](https://github.com/lassediercks/flowgo/commit/da65a6ed84869c42222ed3c96b5bce921a77cf62))
* **editor:** maps can declare they open in hexagon mode ([9dfa797](https://github.com/lassediercks/flowgo/commit/9dfa797a8e41d0ee16ddddec844c83be64f3a2cd))
* **editor:** size hexagons to hold ~120 characters of label text ([a8824cf](https://github.com/lassediercks/flowgo/commit/a8824cf3a11cb5e3ade6d3be4300377b2507b24e))
* **editor:** sized-box labels wrap to the frame and ellipsise overflow ([b778836](https://github.com/lassediercks/flowgo/commit/b77883691286a880d56c45b9c6c5cb2dcebb24bf))
* **editor:** T arms text mode; double-click places a text label ([ac5174e](https://github.com/lassediercks/flowgo/commit/ac5174ecd8bbae96c1c254c436d4fd8fd7d9673e))


### Bug Fixes

* **server:** no-store on the editor page so upgrades aren't served stale ([d67eb3a](https://github.com/lassediercks/flowgo/commit/d67eb3a559662bb2b44b31b0ab9f33657b678c3a))
* three-points map ([e0b447d](https://github.com/lassediercks/flowgo/commit/e0b447d875384b2e1f1c9dfcca1919b766a5172a))

## [0.1.8](https://github.com/lassediercks/flowgo/compare/v0.1.7...v0.1.8) (2026-07-22)


### Features

* **dev:** advertise the host LAN IP from just dev ([85192aa](https://github.com/lassediercks/flowgo/commit/85192aabe3d63dea4d30da608bbefd9855eee3ee))
* **editor:** gate wheel zoom on a modifier so two-finger swipe pans ([e67f8c5](https://github.com/lassediercks/flowgo/commit/e67f8c5088b0b2af19e2e21dbf32a37c23d34f47))
* **editor:** paste and drag-drop images as movable assets ([52809b0](https://github.com/lassediercks/flowgo/commit/52809b0c9d3129376b720ac09c3c77c6ee2b1a00))
* **graph:** add image element to the .flowgo format ([ecec7c3](https://github.com/lassediercks/flowgo/commit/ecec7c3aac08eb6686e948c0691bc87ffaff5723))
* **server:** content-addressed media upload and serving ([f898692](https://github.com/lassediercks/flowgo/commit/f8986929741775147cf66fe747a64e1bc0981587))


### Bug Fixes

* **editor:** hide the map toolbar until navigation needs it ([1cb299b](https://github.com/lassediercks/flowgo/commit/1cb299bfab1830bc6b44cc1cfdec730a4d115380))

## [0.1.7](https://github.com/lassediercks/flowgo/compare/v0.1.6...v0.1.7) (2026-06-08)


### Features

* **editor:** mousewheel zoom + URL persistence hardening ([bd50caa](https://github.com/lassediercks/flowgo/commit/bd50caabd2cf0660a073dcae4e225f17d4ed7c67))

## [0.1.6](https://github.com/lassediercks/flowgo/compare/v0.1.5...v0.1.6) (2026-06-04)


### Features

* **editor:** canvas zoom (pinch / Cmd+scroll) with cursor anchor ([46bd9a3](https://github.com/lassediercks/flowgo/commit/46bd9a34b4d5cf0c1eb55f9efc12876cbce5638d))

## [0.1.5](https://github.com/lassediercks/flowgo/compare/v0.1.4...v0.1.5) (2026-06-02)


### Features

* **editor:** trackpad two-finger pan + Dockerized dev workflow ([fdb93e2](https://github.com/lassediercks/flowgo/commit/fdb93e26ebe85d33241bda921113fd37e23fe9fa))

## [0.1.4](https://github.com/lassediercks/flowgo/compare/v0.1.3...v0.1.4) (2026-05-27)


### Features

* **editor:** add wireCollab extension point + typed mutation events ([52ea1ee](https://github.com/lassediercks/flowgo/commit/52ea1ee96b759ccee293dc576adfe0b25913224f))

## [0.1.3](https://github.com/lassediercks/flowgo/compare/v0.1.2...v0.1.3) (2026-05-26)


### Features

* **editor:** route mutations through mutations.ts wrapper ([55b67ba](https://github.com/lassediercks/flowgo/commit/55b67baa9f340e02c5bef176a067df4ba921b6de))


### Refactoring

* extract pkg/flowgo library + cmd/flowgo binary ([f048a04](https://github.com/lassediercks/flowgo/commit/f048a040c2cd853231098dd4abd6cd7ae2822d55))

## [0.1.2](https://github.com/lassediercks/flowgo/compare/v0.1.1...v0.1.2) (2026-05-20)


### Features

* --host shows LAN IP, add `flowgo upgrade` subcommand ([28b8e85](https://github.com/lassediercks/flowgo/commit/28b8e85559271fc4a87e7fdf7ff4c31cc5921fbd))
* **mcp:** full GUI parity + self-describing surface ([6612e0f](https://github.com/lassediercks/flowgo/commit/6612e0fc824a4ac23c742d0fb87d56b7e69d3cce))


### Bug Fixes

* **ci:** cap release-please search depth to skip pre-v-prefix releases ([e5f3053](https://github.com/lassediercks/flowgo/commit/e5f3053c8e40680650135ad44609ad2d7f639d9e))

## [0.1.1](https://github.com/lassediercks/flowgo/compare/v0.1.0...v0.1.1) (2026-05-19)


### Features

* **editor:** hide breadcrumb toolbar when at root map ([6df06ba](https://github.com/lassediercks/flowgo/commit/6df06baec443726d82ce7fcd66b005e76b9ad6e9))
* **editor:** touch input — mode bar, drawing, selection, endpoint drag ([d888322](https://github.com/lassediercks/flowgo/commit/d888322541ff91c3eeb2cc1750b472d3d8c54efb))
* **line:** control points + render styles ([5b0e675](https://github.com/lassediercks/flowgo/commit/5b0e675351b669b262719799102ffb6419d956b7))


### Refactoring

* **brush,line:** take coords instead of MouseEvent ([ed22bd1](https://github.com/lassediercks/flowgo/commit/ed22bd1043c2eba8e17bf86d18da0473d01ccb84))

## [0.1.0](https://github.com/lassediercks/flowgo/compare/v0.0.23...v0.1.0) (2026-05-19)


### ⚠ BREAKING CHANGES

* remove polygon (triangle/pentagon/hexagon) support

### Features

* **editor:** repurpose +/- for palette stepping; extend palette to edges, lines, and strokes ([d22f784](https://github.com/lassediercks/flowgo/commit/d22f784995d4f297fa7239653123fb85d77d0a58))
* notify user when a newer flowgo release is available ([1949548](https://github.com/lassediercks/flowgo/commit/1949548ffac24e8fc65f14fe66fd928e2087bf6a))
* remove polygon (triangle/pentagon/hexagon) support ([96f498d](https://github.com/lassediercks/flowgo/commit/96f498d9c634c14010ed25e0755a1c1c2f9bc33a))
* stamp flowgo version into .flowgo files on save ([f4d1888](https://github.com/lassediercks/flowgo/commit/f4d1888e6b0c502859680e8687ac4e50096cdb6d))

## [0.0.23](https://github.com/lassediercks/flowgo/compare/v0.0.22...v0.0.23) (2026-05-14)


### Features

* **editor:** align toolbar for multi-selection with auto-spread ([e75eb99](https://github.com/lassediercks/flowgo/commit/e75eb9998e11311c49a4113bb531464d9496d411))
* **editor:** colour brush strokes via 1-9 in brush mode ([3906a9b](https://github.com/lassediercks/flowgo/commit/3906a9b636f89fdb49ba6036ddba6359c550f954))
* **editor:** mirror copied box/text labels to system clipboard ([5406cb9](https://github.com/lassediercks/flowgo/commit/5406cb9f7455c41f08d4995fb2956078514afcf0))


### Bug Fixes

* rebuild dist/index.html ([2b53b28](https://github.com/lassediercks/flowgo/commit/2b53b28e1d774b1475bc8aa956c40275c9098b0f))

## [0.0.22](https://github.com/lassediercks/flowgo/compare/v0.0.21...v0.0.22) (2026-05-11)


### Bug Fixes

* prevent set_state from poisoning the on-disk graph ([41d3a3c](https://github.com/lassediercks/flowgo/commit/41d3a3ce5d4b6f6981ddbcfca64f1dd74e673bc4))
* walk forward to the next free port when 54041 is busy ([d8eebc1](https://github.com/lassediercks/flowgo/commit/d8eebc1ab18a5aa8b604f74a660413007fc03eaa))

## [0.0.21](https://github.com/lassediercks/flowgo/compare/v0.0.20...v0.0.21) (2026-05-04)


### Bug Fixes

* make current selected boxes obvious ([75732bc](https://github.com/lassediercks/flowgo/commit/75732bc54a751dc9d916fa57e1804c6ae0ab9f90))
* type and update readme ([312d25e](https://github.com/lassediercks/flowgo/commit/312d25ece3cf4399b6ede2e28e50726cdb71e910))

## [0.0.20](https://github.com/lassediercks/flowgo/compare/v0.0.19...v0.0.20) (2026-05-04)


### Features

* **editor:** line-draw mode, shape rotation, anchor box, dev loop ([a0d8c00](https://github.com/lassediercks/flowgo/commit/a0d8c00097e348112aa2880d37678f826fbbdf7b))
* **editor:** multi-line labels and Enter-to-edit ([fa7f6de](https://github.com/lassediercks/flowgo/commit/fa7f6de2f71a1055963f23e59202cbe07d3c541d))
* some cli convenience ([594f87e](https://github.com/lassediercks/flowgo/commit/594f87e8ff98a3279a6feb02cf15eb669f90e6b6))


### Bug Fixes

* **validate:** allow newlines in box and text labels ([1581eda](https://github.com/lassediercks/flowgo/commit/1581edad3ed2c3eead32878d18728e8ce59b6a4e))

## [0.0.19](https://github.com/lassediercks/flowgo/compare/v0.0.18...v0.0.19) (2026-05-03)


### Features

* introduce device agnostic help modal ([0f80b30](https://github.com/lassediercks/flowgo/commit/0f80b30212597a9240cb06275abbfb1c1bd986cb))
* remove obsolete strokes ([1fa3e5e](https://github.com/lassediercks/flowgo/commit/1fa3e5e1b11610311c6055a067bc7861327a51e3))

## [0.0.18](https://github.com/lassediercks/flowgo/compare/v0.0.17...v0.0.18) (2026-05-03)


### Features

* **editor:** highlight target handle during link drag ([464cdf9](https://github.com/lassediercks/flowgo/commit/464cdf960e08a3184bb3a2af408d2ab4259ca7e2))
* **editor:** mobile touch gestures + iOS-friendly layout ([c720c6b](https://github.com/lassediercks/flowgo/commit/c720c6bf0ada30e25da200c740d2469d3801a2c0))
* **editor:** pure gesture-classification helpers + tests ([1472835](https://github.com/lassediercks/flowgo/commit/14728355a7184924e48c881a9c5d52d0608a15ca))


### Bug Fixes

* cleanup main map ([37cfd82](https://github.com/lassediercks/flowgo/commit/37cfd82543856d4e9596bc331cc2ceb95ade65c4))

## [0.0.17](https://github.com/lassediercks/flowgo/compare/v0.0.16...v0.0.17) (2026-05-01)


### Bug Fixes

* **mcp:** normalise labels and add Go tests for tool actions ([c0bf034](https://github.com/lassediercks/flowgo/commit/c0bf0341bcb72cf634f478f49713cb09966a15ce))

## [0.0.16](https://github.com/lassediercks/flowgo/compare/v0.0.15...v0.0.16) (2026-05-01)


### Features

* text-item palette/font and 500-char label cap ([e5214c6](https://github.com/lassediercks/flowgo/commit/e5214c628d2731a86e979568acd548c601b1864c))


### Bug Fixes

* **ci:** drop pnpm version from action-setup, defer to packageManager ([89a6d7c](https://github.com/lassediercks/flowgo/commit/89a6d7ce9d144124b494b6328cbc613499663951))
* **editor:** typecheck failures uncovered by ci ([f8954e3](https://github.com/lassediercks/flowgo/commit/f8954e3edbbca8024e6febf36f03933fefd562fb))
* normalize strokes a bit ([7dc373a](https://github.com/lassediercks/flowgo/commit/7dc373aea912df17f377244d591c96daa4f67f50))


### Refactoring

* **editor:** drop dead helpers + unused imports from main.ts ([d82eee5](https://github.com/lassediercks/flowgo/commit/d82eee587a725c5f4814a02a63c1ec0b29c395b8))
* **editor:** extract anchor adapters ([946b8c8](https://github.com/lassediercks/flowgo/commit/946b8c8aa8dfda2e2f4ce591fdf07a0b44427940))
* **editor:** extract cloneSelection into its own module ([4a94f39](https://github.com/lassediercks/flowgo/commit/4a94f3974ca32dbebc4e21ad11308d83414b1cd0))
* **editor:** extract create / delete factories ([7194fab](https://github.com/lassediercks/flowgo/commit/7194fabdb0151ed9092f7e042fad6b80cfa7d47b))
* **editor:** extract document keydown into keys.ts ([0f96926](https://github.com/lassediercks/flowgo/commit/0f96926dc16f5b9f5832353b82399b70052687b4))
* **editor:** extract drag movers + grid snap ([d616ed6](https://github.com/lassediercks/flowgo/commit/d616ed63dc9a6e32b5949c15189dbe9ea4b94342))
* **editor:** extract inline label editing ([8ff8154](https://github.com/lassediercks/flowgo/commit/8ff8154c9da6eb6222467b8175e4559799d4f2b0))
* **editor:** extract mouse handling ([5a68a1c](https://github.com/lassediercks/flowgo/commit/5a68a1c5a43753630cf05a48fcf88ebeae3e1313))
* **editor:** extract navigation module from main.ts ([e909c01](https://github.com/lassediercks/flowgo/commit/e909c01008c41c9ed7acf5378c34f53fd93f0db5))
* **editor:** extract per-item attach handlers + platform helper ([9442915](https://github.com/lassediercks/flowgo/commit/94429155e2f8d61f5ca15bad3b0f0924b5cb0a53))
* **editor:** extract persistence + history module ([4b92268](https://github.com/lassediercks/flowgo/commit/4b922684cab10dc4c668350b4feb04863d9ec4de))
* **editor:** extract render + proximity into render.ts ([8731919](https://github.com/lassediercks/flowgo/commit/8731919dae5829867e4135233e973d171463b32b))

## [0.0.15](https://github.com/lassediercks/flowgo/compare/0.0.14...v0.0.15) (2026-05-01)


### Bug Fixes

* switch to releases with v ([254be82](https://github.com/lassediercks/flowgo/commit/254be82e3977eee36016a0fbc09c426e8f7ba4f2))

## [0.0.14](https://github.com/lassediercks/flowgo/compare/0.0.13...0.0.14) (2026-05-01)


### Bug Fixes

* extract pkg/graph for external import ([3defd1f](https://github.com/lassediercks/flowgo/commit/3defd1fb79fb39c1869f3ec4be6c2fe6db4f89c0))

## [0.0.13](https://github.com/lassediercks/flowgo/compare/0.0.12...0.0.13) (2026-05-01)


### Bug Fixes

* validator and also use it against ourself ([3dc25f6](https://github.com/lassediercks/flowgo/commit/3dc25f63c1ee02fe6e0f1652fd9fe3b6a18c9dc7))

## [0.0.12](https://github.com/lassediercks/flowgo/compare/0.0.11...0.0.12) (2026-05-01)


### Features

* box palettes, font scaling, and MCP parity ([5948ac6](https://github.com/lassediercks/flowgo/commit/5948ac62afa91936ac8a38ea43b0c698d1e6098a))
* brushes and clipboard ([06a94d4](https://github.com/lassediercks/flowgo/commit/06a94d45c928015774955092b2e90b18f95380e4))

## [0.0.11](https://github.com/lassediercks/flowgo/compare/0.0.10...0.0.11) (2026-05-01)


### Features

* trigger new release ([d557446](https://github.com/lassediercks/flowgo/commit/d55744693d01125dcbae86e2830a50f4c7438ba4))

## [0.0.10](https://github.com/lassediercks/flowgo/compare/0.0.9...0.0.10) (2026-05-01)


### Features

* add different shapes ([128567f](https://github.com/lassediercks/flowgo/commit/128567fdc7400cf01968508fef6b8b4365c4f9c0))
* introduce license ([16470be](https://github.com/lassediercks/flowgo/commit/16470be5a36666c7007dd5a3ccd3a846f88ecbec))
* update map ([93c5384](https://github.com/lassediercks/flowgo/commit/93c5384d98c9d2c08be60e23aa0105ab997cbee4))

## [0.0.9](https://github.com/lassediercks/flowgo/compare/0.0.8...0.0.9) (2026-05-01)


### Features

* update initial map ([72942ad](https://github.com/lassediercks/flowgo/commit/72942adc3a1653fa1a5a97108848d65d7704f37c))

## [0.0.8](https://github.com/lassediercks/flowgo/compare/0.0.7...0.0.8) (2026-04-30)


### Features

* presist navigation ([d10cc5b](https://github.com/lassediercks/flowgo/commit/d10cc5ba5680050c29c1df1fad47e3644211d1ed))

## [0.0.7](https://github.com/lassediercks/flowgo/compare/0.0.6...0.0.7) (2026-04-30)


### Bug Fixes

* usability improvements ([c4f755c](https://github.com/lassediercks/flowgo/commit/c4f755ce9417e9b29664596645ff2fab54b1f6b9))

## [0.0.6](https://github.com/lassediercks/flowgo/compare/0.0.5...0.0.6) (2026-04-30)


### Features

* introduce mcp ([9a51504](https://github.com/lassediercks/flowgo/commit/9a51504d6327413597c1bb5e4b5429afbc32af56))

## [0.0.5](https://github.com/lassediercks/flowgo/compare/0.0.4...0.0.5) (2026-04-30)


### Bug Fixes

* panning and connecting ([3448646](https://github.com/lassediercks/flowgo/commit/344864643779a5e9bdb97aa31b3455c796cf30f5))

## [0.0.4](https://github.com/lassediercks/flowgo/compare/0.0.3...0.0.4) (2026-04-30)


### Features

* lines and text ([0558475](https://github.com/lassediercks/flowgo/commit/0558475d4d8701c2441f14f12d8274314d118183))
* panning ([8af520d](https://github.com/lassediercks/flowgo/commit/8af520daad49f51db4beaa9b54b29f86a8c23a0e))

## [0.0.3](https://github.com/lassediercks/flowgo/compare/0.0.2...0.0.3) (2026-04-30)


### Features

* output version ([5f0da70](https://github.com/lassediercks/flowgo/commit/5f0da707a93c05e36d6ce6bb6730cb90e25e44e1))

## [0.0.2](https://github.com/lassediercks/flowgo/compare/0.0.1...0.0.2) (2026-04-30)


### Features

* proximity handlers ([fba3bc6](https://github.com/lassediercks/flowgo/commit/fba3bc66fdffa4466a20f9beb24555ed33f878af))
* remove the connect button ([02181be](https://github.com/lassediercks/flowgo/commit/02181be5448448fb4987e0124347c6e26618e29e))

## 0.0.1 (2026-04-30)


### Features

* add some features ([e9fefe1](https://github.com/lassediercks/flowgo/commit/e9fefe13d7cc5f47d347638f0eab8751b4f990fa))
* stay in patchlevel for now ([e14f48c](https://github.com/lassediercks/flowgo/commit/e14f48c938c9e0ffae06c0aa2b14af423f1c5f76))


### Bug Fixes

* some improvements ([98e2d26](https://github.com/lassediercks/flowgo/commit/98e2d263ba3a456243a10e1605f63ec0193826ca))
