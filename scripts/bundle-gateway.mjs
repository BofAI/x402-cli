import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function gatewayPackageDist() {
  try {
    return path.dirname(require.resolve("@bankofai/x402-gateway/dist/cli.js"));
  } catch {
    return undefined;
  }
}

const source = process.env.X402_GATEWAY_DIST
  ? path.resolve(process.env.X402_GATEWAY_DIST)
  : gatewayPackageDist() ?? path.resolve(root, "..", "x402-gateway", "dist");
const target = path.join(root, "dist", "gateway");

if (!fs.existsSync(path.join(source, "cli.js"))) {
  throw new Error(`gateway dist not found at ${source}; install @bankofai/x402-gateway, run npm run build in x402-gateway, or set X402_GATEWAY_DIST`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const entry of fs.readdirSync(source)) {
  if (entry.endsWith(".js")) {
    fs.copyFileSync(path.join(source, entry), path.join(target, entry));
  }
}

process.stdout.write(`Bundled gateway runtime from ${source}\n`);
