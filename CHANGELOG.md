# Changelog

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
