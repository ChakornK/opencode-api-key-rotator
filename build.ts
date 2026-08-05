import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "@opentui/core", "bun"],
});

console.log("build complete: dist/index.js");
