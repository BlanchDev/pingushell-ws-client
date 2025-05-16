import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { checkRequiredVars, VPS_ID, setVpsId } from "./config";
import { AuthService } from "./services/auth";
import { RealtimeService } from "./services/realtime";
import * as fs from "fs";
import * as path from "path";

// Sağlık durumu API'si
const api = new Elysia()
  .use(cors())
  .get("/", () => ({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    vps_id: VPS_ID || "not_verified",
  }))
  .get("/health", () => ({
    status: "healthy",
    uptime: process.uptime(),
  }))
  .listen(4000);

console.log(`PinguShell WS Client API başlatıldı. Port: ${api.server?.port}`);

/**
 * VPS ID'yi yerel dosyada sakla
 */
const saveVpsId = (vpsId: string): void => {
  try {
    // .env dosyasını güncelle
    const envPath = path.join(process.cwd(), ".env");
    let envContent = "";

    // Dosya varsa oku
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");

      // VPS_ID satırını güncelle veya ekle
      if (envContent.includes("VPS_ID=")) {
        envContent = envContent.replace(/VPS_ID=.*\n/g, `VPS_ID=${vpsId}\n`);
      } else {
        envContent += `\nVPS_ID=${vpsId}\n`;
      }
    } else {
      // Dosya yoksa temel değişkenleri içeren bir .env oluştur
      envContent = `TOKEN=${process.env.TOKEN || ""}\nGITHUB_NAME=${
        process.env.GITHUB_NAME || ""
      }\nVPS_ID=${vpsId}\n`;
    }

    // Dosyayı yaz
    fs.writeFileSync(envPath, envContent);
    console.log(`VPS ID dosyaya kaydedildi: ${vpsId}`);
  } catch (error) {
    console.error("VPS ID kayıt hatası:", error);
  }
};

/**
 * Uygulama başlatma fonksiyonu
 */
const startApp = async () => {
  try {
    // Gerekli ortam değişkenlerini kontrol et
    if (!checkRequiredVars()) {
      console.error("Gerekli ortam değişkenleri eksik, uygulama durduruluyor!");
      process.exit(1);
    }

    // Auth servisi başlat
    const authService = new AuthService();

    // Token doğrulama
    let verifiedVpsId = "";

    // Token doğrula ve VPS ID'sini al
    const verifyResult = await authService.verifyToken();
    if (!verifyResult.success) {
      console.error("Token doğrulama başarısız:", verifyResult.error);
      process.exit(1);
    }

    verifiedVpsId = verifyResult.vps_id || "";
    console.log("Doğrulanan VPS ID:", verifiedVpsId);

    // VPS ID'yi global değişkene ata
    setVpsId(verifiedVpsId);

    // VPS ID'yi .env dosyasına kaydet
    saveVpsId(verifiedVpsId);

    // Daha önce kayıt olmadıysa VPS'i kaydet
    if (!VPS_ID) {
      const registerResult = await authService.registerVps(verifiedVpsId);
      if (!registerResult.success) {
        console.error("VPS kaydı başarısız:", registerResult.error);
        process.exit(1);
      }
    }

    // Realtime servisi başlat
    const realtimeService = new RealtimeService();
    const connected = await realtimeService.connect();

    if (!connected) {
      console.error("WebSocket bağlantısı kurulamadı!");
      process.exit(1);
    }

    // Uygulama kapanma sinyali alındığında
    ["SIGINT", "SIGTERM"].forEach((signal) => {
      process.on(signal, () => {
        console.log(`${signal} sinyali alındı, uygulama kapatılıyor...`);

        // WebSocket bağlantısını kapat
        realtimeService.sendStatus("disconnected");
        realtimeService.disconnect();

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
