import esbuild from "esbuild";
import { readFile } from "node:fs/promises";

const production = process.argv.includes("production");

const emptyNodeEnvPlugin = {
  name: "empty-node-env",
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]lib0[\\/](environment|storage)\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      return {
        contents: source
          .replaceAll("process.env", "({})")
          .replaceAll("localStorage", "undefined"),
        loader: "js"
      };
    });
  }
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@codemirror/commands"],
  format: "cjs",
  target: "es2020",
  plugins: [emptyNodeEnvPlugin],
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}