import WebSocket from "ws";
import { CONNECTION_TOKEN, VPS_ID, ENDPOINT_URL } from "../config";
import { executeCommand } from "../helpers/command";

export class WebSocketClient {
  private ws: WebSocket | null = null;
  public isConnected: boolean = false;
  private reconnectInterval: number = 5000; // 5 saniye
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private roomId: string = ""; // Oda ID'sini sakla
  private clientId: string = ""; // Client ID'yi sakla
  private reconnectCount: number = 0;
  private maxReconnectAttempts: number = 10;

  /**
   * WebSocket bağlantısını başlat
   */
  public async connect(): Promise<boolean> {
    try {
      return new Promise((resolve) => {
        console.log(`WebSocket bağlantısı kuruluyor: ${ENDPOINT_URL}`);

        // Eğer zaten bağlı ise önce kapat
        if (this.ws) {
          try {
            this.ws.close();
          } catch (e) {
            // Hata yok sayılabilir
          }
          this.ws = null;
        }

        // WebSocket bağlantısı kur
        this.ws = new WebSocket(ENDPOINT_URL);

        // Bağlantı açıldığında
        this.ws.onopen = () => {
          console.log("WebSocket bağlantısı başarıyla kuruldu!");
          this.isConnected = true;
          this.reconnectCount = 0; // Başarılı bağlantıda sayaç sıfırla

          // Welcome mesajını bekle, auth gönderme işlemini onmessage içerisinde yapacağız
          console.log("Welcome mesajı bekleniyor...");

          resolve(true);
        };

        // Bağlantı kapandığında
        this.ws.onclose = (event) => {
          console.log(
            `WebSocket bağlantısı kapandı (Kod: ${event.code}), yeniden bağlanılacak...`,
          );
          this.isConnected = false;
          this.stopPingInterval();

          // Yeniden bağlanma
          this.scheduleReconnect();
        };

        // Hata oluştuğunda
        this.ws.onerror = (error) => {
          console.error("WebSocket bağlantı hatası:", error);

          // İlk bağlantı denemesi başarısız olduysa
          if (!this.isConnected) {
            resolve(false);
          }
        };

        // Mesaj alındığında
        this.ws.onmessage = async (event) => {
          try {
            const message = JSON.parse(event.data.toString());
            await this.handleMessage(message);
          } catch (error) {
            console.error("Mesaj işleme hatası:", error);
          }
        };

        // Bağlantı zaman aşımı
        setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            console.log("WebSocket bağlantı zaman aşımı");
            if (this.ws) {
              try {
                this.ws.close();
              } catch (e) {
                // Hata yok sayılabilir
              }
            }
            this.isConnected = false;
            resolve(false);
          }
        }, 10000); // 10 saniye zaman aşımı
      });
    } catch (error) {
      console.error("WebSocket bağlantı hatası:", error);
      return false;
    }
  }

  /**
   * Bağlantıyı kapat
   */
  public disconnect(): void {
    this.stopPingInterval();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      try {
        // Bağlantı durumuna göre mesaj gönder
        if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
          this.sendStatus("disconnected");

          // Bağlantıyı temiz kapatmak için kısa bir gecikme
          setTimeout(() => {
            if (this.ws) this.ws.close();
            this.ws = null;
            this.isConnected = false;
          }, 500);
        } else {
          // Doğrudan kapat
          this.ws.close();
          this.ws = null;
          this.isConnected = false;
        }
      } catch (error) {
        console.error("Bağlantı kapatma hatası:", error);
        // Hata durumunda da temizlik yap
        this.ws = null;
        this.isConnected = false;
      }

      console.log("WebSocket bağlantısı kapatıldı");
    }
  }

  /**
   * Güvenli mesaj gönderme
   */
  private safeSend(data: any): boolean {
    if (!this.isConnected || !this.ws) {
      console.log("WebSocket bağlı değil, mesaj gönderilemiyor");
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      console.log(
        `WebSocket hazır değil (Durum: ${this.ws.readyState}), mesaj gönderilemiyor`,
      );
      return false;
    }

    try {
      // Her mesaja clientId ekle (zaten varsa değiştirme)
      if (data && typeof data === "object" && !data.clientId) {
        if (!data.data) data.data = {};
        if (!data.data.clientId && this.clientId) {
          data.data.clientId = this.clientId;
        }
        if (!data.data.vps_id && VPS_ID) {
          data.data.vps_id = VPS_ID;
        }
      }

      const jsonStr = JSON.stringify(data);
      this.ws.send(jsonStr);
      return true;
    } catch (error) {
      console.error("Mesaj gönderme hatası:", error);
      return false;
    }
  }

  /**
   * Auth mesajı gönder
   */
  private sendAuthMessage(): void {
    console.log(
      `Auth mesajı gönderiliyor... VPS ID: ${VPS_ID}, Client ID: ${this.clientId}`,
    );

    const authMessage = {
      type: "auth",
      data: {
        vps_id: VPS_ID,
        token: CONNECTION_TOKEN,
        clientId: this.clientId, // Server'a client ID'yi de gönder
      },
    };

    this.safeSend(authMessage);
  }

  /**
   * Durum mesajı gönder
   */
  public sendStatus(
    status: "connected" | "disconnected" | "busy" | "ready",
  ): void {
    const statusMessage = {
      type: "status",
      data: {
        status,
        timestamp: new Date().toISOString(),
        clientId: this.clientId,
        vps_id: VPS_ID,
      },
    };

    this.safeSend(statusMessage);
  }

  /**
   * Yeniden bağlanma zamanlayıcısı
   */
  private scheduleReconnect(): void {
    if (!this.reconnectTimeout) {
      this.reconnectCount++;

      // Maksimum deneme sayısını geçti mi kontrol et
      if (this.reconnectCount > this.maxReconnectAttempts) {
        console.log(
          `Maksimum yeniden bağlanma denemesi aşıldı (${this.maxReconnectAttempts}). Bir süre bekleyip tekrar denenecek.`,
        );
        // Daha uzun bir bekleme süresi koy
        setTimeout(() => {
          this.reconnectCount = 0; // Sayacı sıfırla
          this.connect(); // Tekrar dene
        }, 60000); // 1 dakika bekle
        return;
      }

      // Artan bekleme süresi (exponential backoff)
      const delay = Math.min(
        30000,
        this.reconnectInterval * Math.pow(1.5, this.reconnectCount - 1),
      );

      console.log(
        `Yeniden bağlanma planlandı (${this.reconnectCount}/${this.maxReconnectAttempts}). ${delay}ms sonra denenecek.`,
      );

      this.reconnectTimeout = setTimeout(async () => {
        this.reconnectTimeout = null;
        await this.connect();
      }, delay);
    }
  }

  /**
   * Ping zamanlayıcısını başlat
   */
  private startPingInterval(): void {
    this.stopPingInterval();

    this.pingInterval = setInterval(() => {
      if (
        this.isConnected &&
        this.ws &&
        this.ws.readyState === WebSocket.OPEN
      ) {
        // Her 30 saniyede bir ping gönder
        this.safeSend({ type: "ping" });
      }
    }, 30000);
  }

  /**
   * Ping zamanlayıcısını durdur
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Mesajları işle
   */
  private async handleMessage(message: any): Promise<void> {
    console.log(`Mesaj alındı: ${message.type}`);

    switch (message.type) {
      case "welcome":
        // Welcome mesajı alındı, auth gönder
        console.log("Welcome mesajı alındı, Oda ID:", message.data?.roomId);
        if (message.data?.roomId) {
          this.roomId = message.data.roomId;
        }
        if (message.data?.clientId) {
          this.clientId = message.data.clientId;
          console.log("Client ID alındı:", this.clientId);
        }
        // Auth mesajı gönder
        this.sendAuthMessage();
        break;

      case "ping":
        // Ping mesajına pong ile yanıt ver
        this.safeSend({ type: "pong" });
        break;

      case "pong":
        // Pong mesajı alındı, bir şey yapmaya gerek yok
        break;

      case "auth_success":
        // Auth başarılı, durum mesajı gönder
        console.log("Kimlik doğrulama başarılı!");
        this.sendStatus("connected");

        // Ping interval başlat
        this.startPingInterval();
        break;

      case "auth_error":
        // Auth hata, bağlantıyı kapat
        console.error("Kimlik doğrulama hatası:", message.data?.message);
        this.disconnect();
        break;

      case "command":
        // Komut çalıştır
        if (message.data?.command && message.data?.command_id) {
          console.log(
            `Komut alındı: ${message.data.command} (ID: ${message.data.command_id})`,
          );

          // Meşgul durumu bildir
          this.sendStatus("busy");

          try {
            // Komutu çalıştır
            const result = await executeCommand(
              message.data.command,
              message.data.command_id,
            );

            // Sonucu gönder
            this.safeSend({
              type: "command_result",
              data: {
                command_id: message.data.command_id,
                result: result.output,
                exit_code: result.exit_code || 0,
                timestamp: new Date().toISOString(),
              },
            });
          } catch (error) {
            console.error("Komut çalıştırma hatası:", error);

            this.safeSend({
              type: "command_result",
              data: {
                command_id: message.data.command_id,
                result: "Komut çalıştırma hatası oluştu: " + String(error),
                exit_code: 1,
                timestamp: new Date().toISOString(),
              },
            });
          } finally {
            // Hazır durumunu bildir
            this.sendStatus("ready");
          }
        }
        break;

      default:
        console.log(`Bilinmeyen mesaj tipi: ${message.type}`);
    }
  }
}
