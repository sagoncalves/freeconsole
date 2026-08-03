#!/usr/bin/env node
/**
 * Static dev server for public/.
 *
 * Deliberately hand-rolled and dependency-free rather than using `serve`: that package
 * rewrites /play.html to /play, and this project's URLs are load-bearing. The QR code a
 * phone scans, the iframe src the shell builds for a game - both are literal .html paths,
 * and a redirect hop on those is at best noise and at worst drops the ?room= query.
 *
 * Serves paths exactly as Firebase Hosting does, so local and deployed behave the same.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname.endsWith("/")) pathname += "index.html";

  // Resolve inside ROOT and reject anything that escapes it.
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>404</title>` +
          `<body style="font:16px system-ui;background:#05060d;color:#eaf2ff;padding:40px">` +
          `<h1>404</h1><p style="color:#8492b8">No file at <code>${pathname}</code></p>` +
          `<p><a href="/" style="color:#35f0e0">Back to Console</a></p>`
      );
      return;
    }
    const ext = path.extname(filePath).toLowerCase();

    // ES modules are cached separately from ordinary requests, and `no-store` alone does
    // not reliably evict them on a soft reload — a browser can keep serving a module whose
    // exports have since changed, producing "does not provide an export named X". Adding a
    // per-request ETag/Last-Modified pair that always looks fresh forces revalidation.
    const headers = {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    };
    if (ext === ".js" || ext === ".mjs" || ext === ".html") {
      // A changing ETag guarantees the module graph is re-fetched rather than reused.
      headers.ETag = `"${Date.now().toString(36)}"`;
    }

    res.writeHead(200, headers);
    res.end(data);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Stop the other process, or run:  PORT=3001 pnpm dev\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "0.0.0.0", () => {
  const lan = lanAddress();
  console.log("");
  console.log("  Console dev server — live project webconsole-8a62c");
  console.log("  ─────────────────────────────────────────────────");
  console.log(`  This machine   http://localhost:${PORT}`);
  if (lan) console.log(`  Big screen     http://${lan}:${PORT}   <- open this one, so phones can join`);
  console.log("");
  console.log("  Cloud Functions run in the cloud. After editing functions/:");
  console.log("    pnpm deploy:functions");
  console.log("");
});
