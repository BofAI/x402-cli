import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CliError, opt, outputMode, type ParsedOptions } from "./args.js";
import { positiveIntegerOption } from "./http-client.js";
import { emit } from "./output.js";
import type { PaymentRequirement } from "./x402.js";

function stripFlag(argv: string[], flag: string): string[] {
  return argv.filter(item => item !== flag);
}

async function waitForPort(host: string, port: number, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await delay(50);
  }
  throw new Error(`daemon did not become ready on ${host}:${port}`);
}

export async function startServeDaemon(argv: string[], options: ParsedOptions, requirement: PaymentRequirement, script: string): Promise<void> {
  if (!requirement.payTo) throw new CliError("MISSING_ARGUMENT", "--pay-to is required", "Pass --pay-to <recipient address>.", 2);
  const daemonArgs = stripFlag(stripFlag(argv, "--daemon"), "-d");
  const child = spawn(process.execPath, [script, ...daemonArgs], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  const host = opt(options, "host", "127.0.0.1")!;
  const port = positiveIntegerOption(options, "port", 4020);
  const resourceUrl = opt(options, "resource-url", `http://${host}:${port}/pay`)!;
  try {
    await waitForPort(host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host, port);
  } catch (error) {
    if (child.pid) try { process.kill(child.pid); } catch { /* child already exited */ }
    throw error;
  }
  emit({ command: "server", mode: outputMode(options), network: requirement.network, scheme: requirement.scheme,
    result: { pid: child.pid, pay_url: resourceUrl, resource_url: resourceUrl, daemon: true } });
}
