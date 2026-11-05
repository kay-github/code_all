import type { NextConfig } from "next";
import { NOTES_BASE_PATH } from "./src/lib/paths";

const nextConfig: NextConfig = {
  basePath: NOTES_BASE_PATH,
  turbopack: { root: __dirname },
  poweredByHeader: false,
  async redirects() {
    const legacyHost = [{ type: "host" as const, value: "note.688680.xyz" }];
    return [
      { source: "/", destination: "https://note.688680.xyz/notes", basePath: false, has: legacyHost, permanent: false },
      { source: "/:slug((?!notes$)[a-zA-Z0-9_-]{3,30})", destination: "https://note.688680.xyz/notes/:slug", basePath: false, has: legacyHost, permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      {
        source: "/:slug?",
        headers: [
          { key: "Content-Security-Policy", value: "base-uri 'self'; frame-ancestors 'self'; object-src 'none'; form-action 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
