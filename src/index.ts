import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { checkRequiredVars, VPS_ID, CONNECTION_TOKEN } from "./config";
import { WebSocketClient } from "./services/ws";

// WebSocket client
let wsClient: WebSocketClient;

// Sağlık durumu API'si
const api = new Elysia()
  .use(cors())
  .get("/", () => ({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    vps_id: VPS_ID,
  }))
  .get("/health", () => ({
    status: "healthy",
    uptime: process.uptime(),
    connected: wsClient?.isConnected || false,
  }))
  .listen(4000);

console.log(`PinguShell WS Client API başlatıldı. Port: ${api.server?.port}`);

/**
 * Ana uygulama başlatma fonksiyonu
 */
const startApp = async () => {
  try {
    // Gerekli ortam değişkenlerini kontrol et
    if (!checkRequiredVars()) {
      console.error("Gerekli ortam değişkenleri eksik, uygulama durduruluyor!");
      process.exit(1);
    }

    console.log("PinguShell WS Client başlatılıyor...");
    console.log(`VPS ID: ${VPS_ID}`);
    console.log(
      `Connection Token: ${CONNECTION_TOKEN.substring(
        0,
        4,
      )}...${CONNECTION_TOKEN.substring(CONNECTION_TOKEN.length - 4)}`,
    );

    // WebSocket client başlat
    wsClient = new WebSocketClient();
    const connected = await wsClient.connect();

    if (!connected) {
      console.error("WebSocket bağlantısı kurulamadı!");
      process.exit(1);
    }

    // Uygulama kapanma sinyali alındığında
    ["SIGINT", "SIGTERM"].forEach((signal) => {
      process.on(signal, () => {
        console.log(`${signal} sinyali alındı, uygulama kapatılıyor...`);

        // WebSocket bağlantısını kapat
        if (wsClient) {
          wsClient.disconnect();
        }

        // Uygulamayı kapat
        process.exit(0);
      });
    });

    console.log("PinguShell WS Client başarıyla başlatıldı!");
  } catch (error) {
    console.error("Uygulama başlatma hatası:", error);
    process.exit(1);
  }
};

// Uygulamayı başlat
startApp();
