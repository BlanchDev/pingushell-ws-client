import dotenv from "dotenv";

// .env dosyasını yükle
dotenv.config();

// Ortam değişkenlerini al
export const CONNECTION_TOKEN = process.env.CONNECTION_TOKEN!;
export const VPS_ID = process.env.VPS_ID!;
export const ROOM_ID = process.env.ROOM_ID!;
export const SERVER_URL = process.env.SERVER_URL!;
export const ENDPOINT_URL = process.env.ENDPOINT_URL!;

// VPS ID'yi ayarlamak için fonksiyon
export const setVpsId = (id: string): void => {
  process.env.VPS_ID = id;
  console.log(`VPS ID güncellendi: ${id}`);
};

// Room ID'yi ayarlamak için fonksiyon
export const setRoomId = (id: string): void => {
  process.env.ROOM_ID = id;
  console.log(`Room ID güncellendi: ${id}`);
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

  if (!ROOM_ID) {
    console.warn(
      "Uyarı: ROOM_ID belirtilmedi, sunucu tarafından oda ataması yapılacak",
    );
  }

  return true;
};
