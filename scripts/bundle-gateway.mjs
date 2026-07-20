import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function gatewayPackageDist() {
  try {
    return path.join(path.dirname(require.resolve("@bankofai/x402-gateway/package.json")), "dist");
  } catch {
    return undefined;
  }
}

const source = process.env.X402_GATEWAY_DIST
  ? path.resolve(process.env.X402_GATEWAY_DIST)
  : gatewayPackageDist();
const target = path.join(root, "dist", "gateway");

if (!source || !fs.existsSync(path.join(source, "cli.js"))) {
  throw new Error("gateway dist not found in @bankofai/x402-gateway; install dependencies or explicitly set X402_GATEWAY_DIST for development");
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const entry of fs.readdirSync(source)) {
  if (entry.endsWith(".js")) {
    fs.copyFileSync(path.join(source, entry), path.join(target, entry));
  }
}

process.stdout.write(`Bundled gateway runtime from ${source}\n`);
