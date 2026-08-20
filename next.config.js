/** @type {import('next').NextConfig} */
const nextConfig = {
    // ✅ FIX 1: Mencegah Next.js mem-bundel native module (Next.js 14.1+)
    serverExternalPackages: ['better-sqlite3'],
    
    // ✅ FIX 2: Webpack externals sebagai fallback tambahan
    webpack: (config, { isServer }) => {
        if (isServer) {
            // Pastikan externals array ada
            config.externals = config.externals || [];
            
            // Paksa webpack untuk tidak mem-bundel better-sqlite3
            config.externals.push({ 'better-sqlite3': 'commonjs better-sqlite3' });
        }
        return config;
    },
    
    // Konfigurasi CORS yang sudah ada (dipertahankan)
    async headers() {
        return [
            {
                // matching all API routes
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