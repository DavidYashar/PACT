import type { NextConfig } from "next";
import path from "node:path";

/// viem ships a `tempo` module that lazily imports the optional `mppx/client`
/// package. It is never called by this app, but the bundler tries to resolve it and
/// fails the dev compile. Pointing it at an empty module keeps both bundlers quiet.
const optionalStubs = {
  "mppx/client": path.resolve(__dirname, "lib/empty-module.ts"),
};

/// Build-time assertions.
///
/// `NEXT_PUBLIC_*` values are inlined into the browser bundle by `next build`, so one that is set
/// only on the server at runtime produces a bundle carrying the zero address — every read fails and
/// the site renders empty with no error. Render runs the build and the server in the same service,
/// but nothing guarantees the order of a manual deploy, so the build refuses to produce that bundle.
const ZERO = "0x0000000000000000000000000000000000000000";

function assertPublicEnv() {
  const problems: string[] = [];
  for (const name of ["NEXT_PUBLIC_ESCROW_ADDRESS", "NEXT_PUBLIC_NAMES_ADDRESS"]) {
    const value = (process.env[name] ?? "").toLowerCase();
    if (!value || value === ZERO) problems.push(`${name} is unset or zero`);
  }
  const block = process.env.NEXT_PUBLIC_NAMES_DEPLOY_BLOCK ?? "";
  if (!/^[0-9]+$/.test(block.trim())) {
    problems.push("NEXT_PUBLIC_NAMES_DEPLOY_BLOCK is unset or not a block number");
  }
  if (problems.length) {
    throw new Error(`next build refuses to run: ${problems.join("; ")}. These are inlined into the browser bundle.`);
  }
}

assertPublicEnv();

const nextConfig: NextConfig = {
  /// Security headers. The app loads no third-party script, so the policy can be strict: everything
  /// comes from this origin, the wallet connection is an injected provider rather than a script, and
  /// the only network traffic from the browser is JSON-RPC to the chain's public endpoint.
  async headers() {
    const rpc = "https://rpc.mainnet.chain.robinhood.com";
    const csp = [
      "default-src 'self'",
      /// Next's runtime needs inline bootstrap; there is no nonce plumbing in the app router for it.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      `connect-src 'self' ${rpc} https://robinhoodchain.blockscout.com`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
  turbopack: {
    root: __dirname,
    resolveAlias: optionalStubs,
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      ...Object.fromEntries(Object.keys(optionalStubs).map((key) => [key, false])),
    };
    return config;
  },
};

export default nextConfig;
