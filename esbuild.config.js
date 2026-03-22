import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const isWatch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  sourcemap: isWatch ? "inline" : false,
};

const entryPoints = [
  {
    in: "src/background/background.ts",
    out: "background/background",
  },
  {
    in: "src/compose-panel/panel.ts",
    out: "compose-panel/panel",
  },
  {
    in: "src/options/options.ts",
    out: "options/options",
  },
];

function copyStatic(srcDir, destDir) {
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyStatic(srcPath, destPath);
    } else {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
}

async function build() {
  // Copier les fichiers statiques
  copyStatic("src/static", "dist");
  copyStatic("icons", "dist/icons");
  copyFileSync("manifest.json", "dist/manifest.json");

  if (isWatch) {
    const ctx = await esbuild.context({
      ...baseOptions,
      entryPoints,
      outdir: "dist",
    });
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build({
      ...baseOptions,
      entryPoints,
      outdir: "dist",
    });
    console.log("Build complete.");
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
