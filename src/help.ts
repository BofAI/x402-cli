import fs from "node:fs";

export function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function helpText(topic = "root"): string {
  const sections: Record<string, string> = {
    root: `x402-cli ${getVersion()}

Usage:
  x402-cli <command> [options]

Commands:
  pay <url>                 Pay an x402-protected URL
  serve                     Run a local x402 paywall endpoint
  roundtrip                 Start serve, pay it, then exit
  gateway <command>         Manage local gateway provider files
  catalog <command>         Search, cache, and export provider catalog assets

Global options:
  -h, --help                Show help
  -V, --version             Show version
  --json                    Print machine-readable JSON envelope
  --human                   Print human-readable output (default)
`,
    pay: `Usage:
  x402-cli pay <url> [options]

Options:
  --method <method>         HTTP method (default: GET)
  --header "Name: Value"    Request header, repeatable
  --body <body>             Request body for non-GET/HEAD methods
  --network <caip2>         Require a specific network
  --token <symbol>          Require a specific token
  --scheme <scheme>         Require a specific x402 scheme
  --gasfree-api-url <url>   Override the TRON GasFree relayer API URL
  --max-gasfree-fee <amt>   Maximum GasFree relayer fee in token units
  --max-gasfree-fee-raw <n> Maximum GasFree relayer fee in smallest units
  --max-amount <amount>     Maximum human-readable payment amount
  --max-raw-amount <amount> Maximum smallest-unit payment amount
  --dry-run                 Read requirements but do not sign or pay
  --private-key <hex>       Explicit payer private key (or PRIVATE_KEY/TRON_PRIVATE_KEY/EVM_PRIVATE_KEY)
  --rpc-url <url>           Explicit network RPC URL
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --json                    Print JSON envelope

Examples:
  x402-cli pay https://api.example.com/paid --dry-run --json
  x402-cli pay https://api.example.com/paid --max-amount 0.01
`,
    serve: `Usage:
  x402-cli serve --pay-to <address> [options]

Options:
  --pay-to <address>        Recipient wallet address
  --amount <amount>         Human-readable token amount (default: 0.0001)
  --raw-amount <amount>     Smallest-unit amount
  --network <caip2>         Payment network (default: tron:0xcd8690dc)
  --scheme <scheme>         Payment scheme: exact or exact_gasfree (default: exact)
  --token <symbol>          Token symbol (default: USDT)
  --asset <address>         Explicit token address
  --decimals <count>        Token decimals for unregistered --asset
  --host <host>             Bind host (default: 127.0.0.1)
  --port <port>             Bind port (default: 4020)
  --resource-url <url>      URL advertised in payment requirements
  --facilitator-url <url>   Facilitator base URL
  --timeout-ms <ms>         Facilitator timeout in milliseconds (default: 30000)
  --daemon                  Run in background and print the child pid
  --json                    Print JSON envelope

Examples:
  x402-cli serve --pay-to T... --network tron:0xcd8690dc --token USDT
  x402-cli serve --pay-to 0x... --network eip155:97 --token USDT --amount 0.0001
`,
    roundtrip: `Usage:
  x402-cli roundtrip --pay-to <address> [serve/pay options]
`,
    gateway: `Usage:
  x402-cli gateway <search|start|check|scaffold|catalog> [options]

Commands:
  search <query>            Search a gateway/catalog artifact
  start                     Start a local x402 gateway process
  check <providers>         Validate provider.yml files
  scaffold <name>           Write a starter provider.yml
  catalog <command>         Build/check/search gateway catalog assets
`,
    "gateway-catalog": `Usage:
  x402-cli gateway catalog <build|check|pay-assets|search> [options]

Commands:
  build <providers>         Build a local catalog from provider.yml files
  check <providers>         Validate local provider.yml files
  pay-assets <providers>    List payable endpoint assets
  search <query>            Search a catalog artifact
`,
    catalog: `Usage:
  x402-cli catalog <update|search|show|endpoints|pay-json|export-gateway|build> [options]

Commands:
  update                    Cache hosted/local catalog assets under ~/.cache
  search <query>            Search providers
  show <provider>           Show provider detail JSON
  endpoints <provider>      List provider endpoints
  pay-json <provider>       Print provider pay JSON
  export-gateway <url>      Export catalog.json and pay.md from a gateway
  build <providers>         Build catalog from provider.yml files

Options:
  --catalog <source>        catalog.json path or URL
  --provider <fqn>          Provider FQN for export-gateway
  --output-dir <dir>        Output directory for generated files
  -n, --limit <count>       Search result limit
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --include-blocked         Include blocked providers in search
  --json                    Print JSON envelope
`,
    "catalog-search": `Usage:
  x402-cli catalog search <query> [--catalog <source>] [options]

Options:
  --catalog <source>        catalog.json path or URL
  -n, --limit <count>       Search result limit
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --include-blocked         Include blocked providers in search
  --json                    Print JSON envelope
`,
    "catalog-show": `Usage:
  x402-cli catalog show <provider> [--catalog <source>] [options]

Options:
  --catalog <source>        catalog.json path or URL
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --json                    Print JSON envelope
`,
    "catalog-pay-json": `Usage:
  x402-cli catalog pay-json <provider> [--catalog <source>] [options]

Options:
  --catalog <source>        catalog.json path or URL
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --raw                     Print raw pay payload instead of JSON envelope
  --json                    Print JSON envelope
`,
    "catalog-endpoints": `Usage:
  x402-cli catalog endpoints <provider> [--catalog <source>] [options]

Options:
  --catalog <source>        catalog.json path or URL
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --json                    Print JSON envelope
`,
    "catalog-export-gateway": `Usage:
  x402-cli catalog export-gateway <gateway-url> --provider <fqn> [options]

Options:
  --provider <fqn>          Provider FQN to export
  --output-dir <dir>        Output directory for generated files
  --force                   Overwrite existing files
  --json                    Print JSON envelope
`,
  };
  return sections[topic] ?? sections.root;
}

