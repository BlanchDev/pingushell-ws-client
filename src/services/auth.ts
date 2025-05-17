import { CONNECTION_TOKEN, SERVER_URL, setVpsId } from "../config";
import { getSystemInfo } from "../helpers/command";

/**
 * VPS doğrulama ve onay işlemlerini yöneten servis
 */
export class AuthService {
  /**
   * VPS token'ını doğrula
   */
  public async verifyToken(): Promise<{
    success: boolean;
    vps_id?: string;
    error?: string;
  }> {
    try {
      console.log("Token doğrulanıyor...");

      // Token doğrulama isteği
      const response = await fetch(
        `${SERVER_URL}/install/verify/${CONNECTION_TOKEN}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            token: CONNECTION_TOKEN,
          }),
        },
      );

      const data = await response.json();

      if (!data.valid || !data.vps_id) {
        return {
          success: false,
          error: data.error || "Geçersiz token veya eksik VPS ID",
        };
      }

      // VPS ID'yi ayarla
      setVpsId(data.vps_id);

      console.log(`Token doğrulandı. VPS ID: ${data.vps_id}`);
      return { success: true, vps_id: data.vps_id };
    } catch (error: any) {
      console.error("Token doğrulama hatası:", error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * VPS kaydını tamamla
   */
  public async registerVps(
    vps_id: string,
  ): Promise<{ success: boolean; error?: string; vps_id?: string }> {
    try {
      console.log("VPS bilgileri toplanıyor...");

      // Sistem bilgilerini al
      const systemInfo = await getSystemInfo();

      console.log("VPS sunucuya kaydediliyor...");

      // Kayıt isteği
      const response = await fetch(`${SERVER_URL}/install/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: CONNECTION_TOKEN,
          vps_id: vps_id,
          hostname: systemInfo.hostname,
          system_info: systemInfo,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        return {
          success: false,
          error: data.error || "VPS kaydı sırasında bir hata oluştu",
        };
      }

      // VPS ID'yi ayarla
      setVpsId(data.vps_id);

      console.log(`Token doğrulandı. VPS ID: ${data.vps_id}`);
      console.log(`Global VPS_ID değerine atandı: ${data.vps_id}`);

      // Doğrulama kontrolü
      const { VPS_ID } = await import("../config");
      console.log(`İçe aktarılan VPS_ID değeri: ${VPS_ID}`);

      return { success: true, vps_id: data.vps_id };
    } catch (error: any) {
      console.error("VPS kayıt hatası:", error.message);
      return { success: false, error: error.message };
    }
  }
}
