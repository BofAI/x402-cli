export type ParsedOptions = Record<string, string | boolean | string[]>;
export type OutputMode = "human" | "json";

const BOOLEAN_FLAGS = new Set([
  "daemon", "dry-run", "force", "help", "human", "include-blocked", "json", "raw", "version",
]);

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint: string,
    public exitCode = 1,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function parseArgs(argv: string[]): { command: string; positional: string[]; options: ParsedOptions } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const options: ParsedOptions = {};
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (item === "-h") { options.help = true; continue; }
    if (item === "-V") { options.version = true; continue; }
    if (item === "-d") { options.daemon = true; continue; }
    if (item === "-n") {
      const next = rest[i + 1];
      if (!next || next.startsWith("-")) options.limit = true;
      else { options.limit = next; i += 1; }
      continue;
    }
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const eq = item.indexOf("=");
    const key = eq > 2 ? item.slice(2, eq) : item.slice(2);
    const inline = eq > 2 ? item.slice(eq + 1) : undefined;
    const next = rest[i + 1];
    if (inline !== undefined) {
      if (key === "header") {
        const current = options[key];
        options[key] = Array.isArray(current) ? [...current, inline] : current ? [String(current), inline] : [inline];
      } else options[key] = inline;
    }
    else if (BOOLEAN_FLAGS.has(key)) options[key] = true;
    else if (!next || next.startsWith("--")) {
      throw new CliError("MISSING_ARGUMENT", `--${key} requires a value`, `Pass --${key} <value>.`, 2);
    } else {
      if (key === "header") {
        const current = options[key];
        options[key] = Array.isArray(current) ? [...current, next] : current ? [String(current), next] : [next];
      } else options[key] = next;
      i += 1;
    }
  }
  return { command, positional, options };
}

export function opt(options: ParsedOptions, key: string, fallback?: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : fallback;
}

export function hasFlag(options: ParsedOptions, key: string): boolean {
  return options[key] === true;
}

export function outputMode(options: ParsedOptions): OutputMode {
  if (hasFlag(options, "json") && hasFlag(options, "human")) {
    throw new CliError("INVALID_ARGUMENT", "--json and --human are mutually exclusive", "Pass either --json or --human, not both.", 2);
  }
  return hasFlag(options, "json") ? "json" : "human";
}

export function requireArgument(value: string | undefined, name: string, usage: string): string {
  if (value === undefined || value === "") {
    throw new CliError("MISSING_ARGUMENT", `${name} is required`, `Usage: ${usage}`, 2);
  }
  return value;
}

export function optAll(options: ParsedOptions, key: string): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}
