import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  // Use this mode specifically for Capacitor builds: `vite build --mode capacitor`
  const isCapacitor = mode === "capacitor";

  return {
    // ✅ Capacitor must use relative paths to avoid /TTS/assets/... 404 in WebView
    // ✅ Web deploy (GitHub pages) can keep /TTS/
    base: isCapacitor ? "./" : "/TTS/",

    plugins: [
      react(),

      // ✅ PWA is great for the website, but inside Capacitor it causes
      // registerSW.js / manifest.webmanifest requests and can break loading.
      // So we disable PWA for capacitor builds.
      !isCapacitor &&
        VitePWA({
          registerType: "autoUpdate",
          injectRegister: "auto",
          manifest: {
            name: "Talevox: Intelligent Reader",
            short_name: "Talevox",
            description: "AI-Powered Intelligent TTS Reader with Web Content Extraction",
            theme_color: "#4f46e5",
            background_color: "#0f172a",
            display: "standalone",
            orientation: "portrait",
            icons: [
              {
                src: "https://cdn-icons-png.flaticon.com/512/3145/3145761.png",
                sizes: "192x192",
                type: "image/png",
              },
              {
                src: "https://cdn-icons-png.flaticon.com/512/3145/3145761.png",
                sizes: "512x512",
                type: "image/png",
              },
            ],
          },
          workbox: {
            cacheId: "talevox-v2.9.12",
            cleanupOutdatedCaches: true,
          },
        }),
    ].filter(Boolean),

    define: {
      "process.env": {},
      __APP_VERSION__: JSON.stringify("2.9.12"),
    },

    server: {
      port: 3000,
    },
  };
});
