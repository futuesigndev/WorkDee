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


const nextConfig: NextConfig = {
  output: "standalone",
  // `allowedDevOrigins` must contain the host the phone/LINE actually opens (derived from
  // NEXT_PUBLIC_LIFF_API_URL above), otherwise `next dev` blocks its own /_next/* assets.
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
