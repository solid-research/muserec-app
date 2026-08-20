/** @type {import('next').NextConfig} */
const nextConfig = {
    // ✅ FIX 1: Jangan bundle native module (Next.js 14.1+)
    serverExternalPackages: ['better-sqlite3'],

    // ✅ FIX 2: Webpack externals sebagai fallback
    webpack: (config, { isServer }) => {
        if (isServer) {
            config.externals = config.externals || [];
            config.externals.push({ 'better-sqlite3': 'commonjs better-sqlite3' });
        }
        return config;
    },

    // ✅ FIX 3 (KRITIS): Paksa file .db ikut ter-bundle ke function Vercel.
    // Node File Tracing (@vercel/nft) tidak otomatis include file .db
    // karena tidak di-import. Tanpa ini, di Vercel file tidak ada / korup.
    outputFileTracingIncludes: {
        '/api/search': ['./data/muserec.db'],
        // Tambahkan route lain yang juga pakai DB:
        // '/api/other-route': ['./data/muserec.db'],
    },

    // ✅ FIX 4: Longgarkan batasan ukuran untuk file binary besar
    experimental: {
        // Izinkan static file > 1MB (DB Anda ~jutaan row)
        largePageDataBytes: 1024 * 1024 * 100, // 100MB
    },

    // CORS yang sudah ada
    async headers() {
        return [
            {
                source: "/api/:path*",
                headers: [
                    { key: "Access-Control-Allow-Credentials", value: "true" },
                    { key: "Access-Control-Allow-Origin", value: "*" },
                    { key: "Access-Control-Allow-Methods", value: "GET,DELETE,PATCH,POST,PUT" },
                    { key: "Access-Control-Allow-Headers", value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version" },
                ]
            }
        ]
    }
}

module.exports = nextConfig