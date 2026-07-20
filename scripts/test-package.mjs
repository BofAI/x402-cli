import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const { version: expectedVersion } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
const temp = mkdtempSync(path.join(os.tmpdir(), "x402-cli-pack-"));
try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--silent"], { cwd: root, encoding: "utf8" });
  const jsonStart = packOutput.indexOf("[\n");
  assert.notEqual(jsonStart, -1, `npm pack did not return JSON: ${packOutput.slice(0, 200)}`);
  const packed = JSON.parse(packOutput.slice(jsonStart));
  const tarball = path.join(root, packed[0].filename);
  execFileSync("npm", ["init", "-y"], { cwd: temp, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: temp, stdio: "ignore" });
  const cli = path.join(temp, "node_modules", ".bin", "x402-cli");
  const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
  assert.equal(version, expectedVersion);
  const gatewayHelp = execFileSync(cli, ["gateway", "--help"], { encoding: "utf8" });
  assert.match(gatewayHelp, /gateway/iu);
  rmSync(tarball, { force: true });
  process.stdout.write(`verified packed CLI ${version}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
