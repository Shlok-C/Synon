import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";

const watch = process.argv.includes("--watch");

const entryPoints = [
  { in: "src/content/index.ts", out: "content" },
  { in: "src/background.ts", out: "background" },
  { in: "src/popup/popup.ts", out: "popup/popup" },
];

const buildOptions = {
  entryPoints,
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: "es2020",
  logLevel: "info",
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
