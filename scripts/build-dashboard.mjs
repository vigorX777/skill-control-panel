#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import * as esbuild from "esbuild";

const root = resolve(".");
const outDir = resolve(root, "assets/dashboard");

await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, "src/dashboard/main.jsx")],
  bundle: true,
  outfile: resolve(outDir, "app.js"),
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  sourcemap: false,
  minify: false,
  target: ["es2020"],
  loader: {
    ".jsx": "jsx",
  },
});

for (const file of ["index.html", "styles.css"]) {
  const source = resolve(root, "src/dashboard", file);
  const target = resolve(outDir, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
}

console.log(`Built dashboard into ${outDir}`);
