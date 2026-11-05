import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, existsSync, watch } from "fs";

const isWatch = process.argv.includes("--watch");

const entryPoints = [
  { in: "src/content/index.ts", out: "content" },
  { in: "src/background/index.ts", out: "background" },
  { in: "src/popup/popup.ts", out: "popup/popup" },
];

// Minimal .env parser — no dotenv dependency needed for one key.
function loadEnv(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnv(".env");

const buildOptions = {
  entryPoints,
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: "es2020",
  logLevel: "info",
  define: {
    __OPENROUTERS_KEY__: JSON.stringify(env.OPENROUTERS_KEY || ""),
  },
};

// Copy static files to dist
cpSync("src/popup/popup.html", "dist/popup/popup.html");

// Copy PDF.js library files needed by the viewer
mkdirSync("pdfjs/build", { recursive: true });
mkdirSync("pdfjs/web", { recursive: true });
// Vendored runtime files — re-copied every build so a pdfjs-dist upgrade
// (bumped in package.json) is never silently served stale.
cpSync("node_modules/pdfjs-dist/build/pdf.mjs", "pdfjs/build/pdf.mjs");
cpSync("node_modules/pdfjs-dist/build/pdf.worker.mjs", "pdfjs/build/pdf.worker.mjs");
cpSync("node_modules/pdfjs-dist/web/pdf_viewer.css", "pdfjs/web/pdf_viewer.css");

function copyViewerSource() {
  cpSync("src/pdfjs/viewer.html", "pdfjs/web/viewer.html");
  cpSync("src/pdfjs/viewer.js", "pdfjs/web/viewer.js");
}
copyViewerSource();

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  // esbuild's own watch only covers its bundled entry points — src/pdfjs/*
  // is copied verbatim (see CLAUDE.md), so it needs its own watcher or
  // edits during `npm run watch` silently serve stale output.
  watch("src/pdfjs", { persistent: true }, (_event, filename) => {
    if (filename !== "viewer.html" && filename !== "viewer.js") return;
    // Editors/git replace files non-atomically, so the change event can fire
    // while the file is momentarily absent — ignore that instead of crashing.
    if (!existsSync(`src/pdfjs/${filename}`)) return;
    try {
      copyViewerSource();
      console.log(`Copied src/pdfjs/${filename} -> pdfjs/web/`);
    } catch (err) {
      console.error(`Failed to copy src/pdfjs/${filename}:`, err.message);
    }
  });
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
}
