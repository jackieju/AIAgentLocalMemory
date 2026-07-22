import { transformFileSync } from "@babel/core";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(import.meta.dir, "..", "package.json"));
const presetTs = require.resolve("@babel/preset-typescript");
const presetSolid = require.resolve("babel-preset-solid");
const moduleResolver = require.resolve("babel-plugin-module-resolver");

const SRC = join(import.meta.dir, "..", "src", "tui", "index.tsx");
const OUT = join(import.meta.dir, "..", "src", "tui-compiled", "index.tsx");

const runtime = "opentui:runtime-module:%40opentui%2Fsolid";

const result = transformFileSync(SRC, {
  presets: [
    [presetTs, { onlyRemoveTypeImports: true, ignoreExtensions: true }],
    [presetSolid, { moduleName: runtime, generate: "universal" }],
  ],
  plugins: [
    [moduleResolver, {
      alias: {
        "solid-js": "opentui:runtime-module:solid-js",
        "@opentui/solid": runtime,
        "@opentui/solid/components": "opentui:runtime-module:%40opentui%2Fsolid%2Fcomponents",
        "@opentui/core": "opentui:runtime-module:%40opentui%2Fcore",
      },
    }],
  ],
  filename: SRC,
  babelrc: false,
  configFile: false,
});

if (!result?.code) {
  console.error("[build-tui] babel produced no output");
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, "/** @jsxImportSource @opentui/solid */\n// @ts-nocheck\n" + result.code + "\n");
console.log(`[build-tui] compiled ${SRC} -> ${OUT}`);
