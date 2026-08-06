// @ts-check
import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";

/**
 * Astro + Vite config for FreeConsole.
 *
 * The frontend used to be a hand-rolled static server over public/. Astro now builds the
 * five pages that have always been HTML (index, play, signup, docs, diag) as .astro files
 * in src/pages, with Vite handling the module graph. Everything else — games/, vendor/,
 * the design system CSS, the shared JS modules — stays in public/ and is served verbatim
 * at root URLs, because those URLs are load-bearing:
 *
 *   - iframes load `/games/<id>/screen.html` and `controller.html` literally
 *   - ./relay.js etc. are imported by relative URL from inlined page scripts
 *
 * `output: "static"` with `trailingSlash: false` keeps '/play.html' as '/play.html' so QR
 * codes and the ?room= query keep working.
 */
export default defineConfig({
  site: "https://freeconsole.app",
  output: "static",
  trailingSlash: "never",
  build: {
    // Astro would otherwise drop /play.html -> /play; we want the literal .html URL, so
    // keep the extension in the output filename.
    format: "file",
  },
  devToolbar: { enabled: false },
  vite: {
    build: {
      // lightningcss trips on some legacy CSS fixtures (empty after comment stripping);
      // keep cssMinify off until migrated — gzip still wins most of the bytes back.
      cssMinify: false,
      rollupOptions: {
        // The platform's shared ES modules live in public/ (relay.js, session.js, room.js,
        // peer.js, sdk.js, chrome.js, qr.js, player-colors.js, firebase-config.js) and are
        // served as static files at root URLs. They are imported from inside the Astro
        // pages' inline <script type="module"> as "/relay.js" etc, and they import each other
        // with the same path. Vite would otherwise try to resolve and bundle them, which
        // fights the rest of the platform:
        //   - games/ iframes load /sdk.js via <script src>, so sdk.js must stay at /sdk.js
        //   - these modules reference each other by absolute path, so they can't move to src/
        // Marking them external keeps `import "/relay.js"` as a literal URL in the output,
        // which the browser then serves from public/ as it always has.
        external: [/^\/(relay|session|room|peer|sdk|chrome|account|qr|player-colors|firebase-config)\.js($|\?)/],
      },
    },
  },
});
