import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

/**
 * The wasm plugin exists for Rapier.
 *
 * `@dimforge/rapier3d-compat` inlines its WebAssembly as base64 inside a JS
 * module, which cost 842 KB gzipped — base64 wastes a third of its bytes and
 * compresses poorly on top of that. The non-compat package ships the real
 * `.wasm`, which gzips to ~570 KB and goes through the browser's streaming
 * compiler instead of being decoded from a string at runtime.
 *
 * No top-level-await plugin: that package requires rollup, and Vite 8 bundles
 * with rolldown. It is also unnecessary — an `esnext` target supports top-level
 * await natively, which is the only reason the plugin existed.
 */
export default defineConfig({
  /**
   * GitHub Pages serves this as a project site under
   * `/forbidden-city-paintball/`, not from a domain root. A relative base emits
   * asset URLs relative to the HTML document, so the same build works at that
   * subpath, at a domain root, and at `vite preview`'s `/` — which is what the
   * Playwright suites in `tools/` point at. Anything URL-building goes through
   * `import.meta.env.BASE_URL`, which resolves against the document either way.
   */
  base: './',
  plugins: [wasm()],
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});
