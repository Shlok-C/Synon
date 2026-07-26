import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync, readFileSync } from "fs";

const watch = process.argv.includes("--watch");

const entryPoints = [
  { in: "src/content/index.ts", out: "content" },
  { in: "src/background.ts", out: "background" },
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
    __OPENROUTERS_API_KEY__: JSON.stringify(env.OPENROUTERS_KEY || ""),
  },
};

// Copy static files to dist
cpSync("src/popup/popup.html", "dist/popup/popup.html", { recursive: true });

// Copy PDF.js library files needed by the viewer
mkdirSync("pdfjs/build", { recursive: true });
mkdirSync("pdfjs/web", { recursive: true });
if (!existsSync("pdfjs/build/pdf.mjs")) {
  cpSync("node_modules/pdfjs-dist/build/pdf.mjs", "pdfjs/build/pdf.mjs");
  cpSync("node_modules/pdfjs-dist/build/pdf.worker.mjs", "pdfjs/build/pdf.worker.mjs");
  cpSync("node_modules/pdfjs-dist/web/pdf_viewer.css", "pdfjs/web/pdf_viewer.css");
}
// Always copy the viewer HTML (it's our source file, cheap to copy)
cpSync("src/pdfjs/viewer.html", "pdfjs/web/viewer.html");
cpSync("src/pdfjs/viewer.js", "pdfjs/web/viewer.js");

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
}
