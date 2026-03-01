import * as esbuild from "esbuild";
import { cpSync } from "fs";

const watch = process.argv.includes("--watch");

const entryPoints = [
  { in: "src/content.ts", out: "content" },
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

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
}
