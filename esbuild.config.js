import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

function getVersion() {
  const envVersion = process.env.VERSION;
  if (envVersion) return envVersion.replace(/^v/, "");
  try {
    return execSync("git describe --tags --abbrev=0").toString().trim().replace(/^v/, "");
  } catch {
    return "0.0.0-dev";
  }
}

const version = getVersion();

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
  const manifest = JSON.parse(readFileSync("manifest.json", "utf-8"));
  manifest.version = version;
  writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2));

  // Copier le WASM et son runtime Go
  mkdirSync("dist/background", { recursive: true });
  copyFileSync("vendor/genai/genai.wasm", "dist/background/genai.wasm");
  copyFileSync(`vendor/genai/wasm_exec.js`, "dist/background/wasm_exec.js");

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
