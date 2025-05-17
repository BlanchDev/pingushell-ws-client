import dotenv from "dotenv";

// .env dosyasını yükle
dotenv.config();

// Ortam değişkenlerini al
export const CONNECTION_TOKEN = process.env.CONNECTION_TOKEN || "";
export const SERVER_URL = process.env.SERVER_URL || "https://pingushell.com";
export const ENDPOINT_URL =
  process.env.ENDPOINT_URL || "wss://pingushell.com/ws";

// VPS ID'si (doğrulama sonrası doldurulacak)
export let VPS_ID = process.env.VPS_ID || "";
export const setVpsId = (id: string) => {
  VPS_ID = id;
};

// Uygulamanın çalışmasına engel olacak eksik değişkenler
export const requiredVars = ["CONNECTION_TOKEN"];

// Gereken değişkenleri kontrol et
export const checkRequiredVars = (): boolean => {
  const missingVars: string[] = [];

  requiredVars.forEach((varName) => {
    if (!process.env[varName]) {
      missingVars.push(varName);
    }
  });

  if (missingVars.length > 0) {
    console.error(`Eksik ortam değişkenleri: ${missingVars.join(", ")}`);
    return false;
  }

  return true;
};
