import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "prism-transport": "src/index.ts" },
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  clean: true,
  outDir: "dist",
  target: "es2022",
  // p-queue is ESM-only, so we bundle it into the CJS output
  // to keep CJS consumers working without ERR_REQUIRE_ESM.
  noExternal: ["p-queue"],
});
