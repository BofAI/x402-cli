import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.X402_GATEWAY_DIST
  ? path.resolve(process.env.X402_GATEWAY_DIST)
  : path.resolve(root, "..", "x402-gateway", "dist");
const target = path.join(root, "dist", "gateway");

if (!fs.existsSync(path.join(source, "cli.js"))) {
  throw new Error(`gateway dist not found at ${source}; run npm run build in x402-gateway or set X402_GATEWAY_DIST`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const entry of fs.readdirSync(source)) {
  if (entry.endsWith(".js")) {
    fs.copyFileSync(path.join(source, entry), path.join(target, entry));
  }
}

process.stdout.write(`Bundled gateway runtime from ${source}\n`);
