/** Static export: `npm run build` writes a plain site to /out that any host can serve. */
const nextConfig = {
  output: "export",
  // Pages are exported as folder/index.html, so the header's /vaults/, /borrow/ and /portfolio/ links resolve on any static host.
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  transpilePackages: ["@stockfill/engine"],
  webpack: (config) => {
    // The engine uses ESM-style ".js" import paths for its .ts files.
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
export default nextConfig;
