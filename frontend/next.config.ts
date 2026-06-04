import type { NextConfig } from "next";

const liffApiUrl = process.env.NEXT_PUBLIC_LIFF_API_URL || "";
const allowedOrigins: string[] = [];
if (liffApiUrl) {
  try {
    const parsed = new URL(liffApiUrl).hostname;
    if (!allowedOrigins.includes(parsed)) {
      allowedOrigins.push(parsed);
    }
  } catch (e) {
    // Ignore invalid URLs
  }
}


const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: allowedOrigins,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "ngrok-skip-browser-warning",
            value: "true",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8011"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
