import dotenv from "dotenv";

// .env dosyasını yükle
dotenv.config();

// Ortam değişkenlerini al
export const CONNECTION_TOKEN = process.env.CONNECTION_TOKEN || "";
export const TOKEN = CONNECTION_TOKEN; // Alternatif isim için alias
export const VPS_ID = process.env.VPS_ID || "";
export const SERVER_URL =
  process.env.SERVER_URL || "https://pingushell.com/api";
export const ENDPOINT_URL =
  process.env.ENDPOINT_URL || "wss://pingushell.com/ws";
export const COMMAND_SCRIPT =
  process.env.COMMAND_SCRIPT || "/opt/pingushell/run-command.sh";

// VPS ID'yi ayarlamak için fonksiyon
export const setVpsId = (id: string): void => {
  process.env.VPS_ID = id;
  console.log(`VPS ID güncellendi: ${id}`);
};

// Gereken değişkenleri kontrol et
export const checkRequiredVars = (): boolean => {
  if (!CONNECTION_TOKEN) {
    console.error("Eksik ortam değişkeni: CONNECTION_TOKEN");
    return false;
  }

  if (!VPS_ID) {
    console.error("Eksik ortam değişkeni: VPS_ID");
    return false;
  }

  return true;
};
