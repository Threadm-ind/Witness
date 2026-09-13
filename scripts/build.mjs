import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, "package.json"));

function viteBin() {
  const pkgPath = require.resolve("vite/package.json");
  const pkgDir = path.dirname(pkgPath);
  return path.join(pkgDir, "bin", "vite.js");
}

function run(args) {
  const bin = viteBin();
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`vite ${args.join(" ")} failed with status ${res.status}`);
  }
}

const dev = process.argv.includes("--dev");

if (dev) {
  process.env["WITNESS_DEV"] = "1";
  // Build replay first so the dev app embeds a fresh viewer bundle.
  run(["build", "--config", "vite.replay.config.ts"]);
  run(["--host", "127.0.0.1", "--port", "4182", "--strictPort"]);
} else {
  // Production always rebuilds both: replay viewer first, then the app.
  run(["build", "--config", "vite.replay.config.ts"]);
  run(["build"]);
}
