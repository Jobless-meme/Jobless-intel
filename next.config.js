/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { webpack }) => {
    // components/WagmiProviders.tsx only imports the `injected` connector
    // from "wagmi/connectors", but that subpath is a single barrel file
    // that also bundles the Coinbase Smart Wallet connector. That
    // connector imports `@base-org/account`, which in turn imports
    // packages from the optional `@x402` payment-protocol scope (e.g.
    // `@x402/evm`) that this app never uses and that aren't installed.
    // Webpack still has to resolve every import in the barrel file at
    // build time even though it's dead code for us, so without this the
    // build fails with:
    //   Module not found: Can't resolve '@x402/evm'
    //
    // IgnorePlugin below stubs out the ENTIRE @x402/* scope as empty
    // modules (not just the one package the last build happened to hit
    // first) — @base-org/account's Coinbase Smart Wallet code can pull in
    // several @x402/* subpackages (core, evm, svm, ...), and without this
    // broader match, fixing one just surfaces the next one on the next
    // deploy. The explicit alias is kept alongside it belt-and-suspenders,
    // in case a future build tooling change handles one mechanism but not
    // the other.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/evm": false,
    };
    return config;
  },
};

module.exports = nextConfig;
