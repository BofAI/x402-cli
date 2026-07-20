import fs from "node:fs";
import { CliError, opt, type ParsedOptions } from "./args.js";

const MAX_HTTP_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export function positiveIntegerOption(options: ParsedOptions, key: string, fallback: number): number {
  const value = opt(options, key, String(fallback))!;
  if (!/^\d+$/.test(value)) throw new CliError("INVALID_ARGUMENT", `--${key} must be a positive integer`, `Pass --${key} with a value greater than zero.`, 2);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CliError("INVALID_ARGUMENT", `--${key} must be a positive integer`, `Pass --${key} with a value greater than zero.`, 2);
  return parsed;
}

export function timeoutMs(options?: ParsedOptions): number {
  return options ? positiveIntegerOption(options, "timeout-ms", DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

export async function fetchWithTimeout(input: string | URL, init: RequestInit = {}, timeout = DEFAULT_TIMEOUT_MS, label = "request"): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`${label} timed out after ${timeout}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readBoundedText(response: Response, label: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) throw new Error(`${label} exceeds ${MAX_HTTP_BODY_BYTES} byte limit`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HTTP_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`${label} exceeds ${MAX_HTTP_BODY_BYTES} byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function readText(source: string, options?: ParsedOptions): Promise<string> {
  if (!source.startsWith("http://") && !source.startsWith("https://")) return fs.readFileSync(source, "utf8");
  const response = await fetchWithTimeout(source, {}, timeoutMs(options), `fetch ${source}`);
  if (!response.ok) throw new Error(`failed to fetch ${source}: ${response.status}`);
  return readBoundedText(response, `response from ${source}`);
}

export async function readJson(source: string, options?: ParsedOptions): Promise<any> {
  return JSON.parse(await readText(source, options));
}

export async function responsePayload(response: Response): Promise<unknown> {
  const text = await readBoundedText(response, "HTTP response");
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}
