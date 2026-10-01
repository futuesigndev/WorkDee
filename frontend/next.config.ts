import type { NextConfig } from "next";

const liffApiUrl = process.env.NEXT_PUBLIC_LIFF_API_URL || "";
const allowedOrigins: string[] = [];
if (liffApiUrl) {
  try {
    const parsed = new URL(liffApiUrl).hostname;
    if (!allowedOrigins.includes(parsed)) {
      allowedOrigins.push(parsed);
    }
  } catch {
    // Ignore invalid URLs
  }
}

// Dev-only extras (comma-separated hosts/IPs): the address a developer opens the dev server with
// over the LAN or a VPN. The real value for this project lives in the git-ignored `.env.local`
// (`DEV_ALLOWED_ORIGINS=<host>,<host>`), so no network address is ever written into a tracked file.
// Unset or empty adds nothing, which leaves the list exactly as it was before.
for (const entry of (process.env.DEV_ALLOWED_ORIGINS ?? "").split(",")) {
  const host = entry.trim();
  if (host && !allowedOrigins.includes(host)) {
    allowedOrigins.push(host);
  }
}


const nextConfig: NextConfig = {
  output: "standalone",
  // `allowedDevOrigins` must contain the host the phone/LINE actually opens (derived from
  // NEXT_PUBLIC_LIFF_API_URL above) plus every host listed in DEV_ALLOWED_ORIGINS, otherwise
  // `next dev` blocks its own /_next/* assets.
  allowedDevOrigins: allowedOrigins,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8019"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
