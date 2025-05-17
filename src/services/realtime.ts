import { VPS_ID, CONNECTION_TOKEN, ENDPOINT_URL } from "../config";
import { executeCommand } from "../helpers/command";

interface CommandMessage {
  type: "command";
  data: {
    command: string;
    requestId: string;
  };
}

interface PingMessage {
  type: "ping";
}

type Message = CommandMessage | PingMessage;

/**
 * WebSocket ile VPS ve sunucu arasındaki iletişimi sağlayan servis
 */
export class RealtimeService {
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private reconnectInterval: number = 5000; // 5 saniye
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private roomId: string = ""; // Oda ID'sini sakla
  private clientId: string = ""; // Client ID'yi sakla
  private reconnectCount: number = 0;
  private maxReconnectAttempts: number = 10;

  /**
   * WebSocket bağlantısını oluştur
   */
  public async connect(): Promise<boolean> {
    try {
      return new Promise((resolve) => {
        console.log(`WebSocket bağlantısı kuruluyor: ${ENDPOINT_URL}`);
        console.log(`Token değeri: '${CONNECTION_TOKEN}'`);
        console.log(`VPS ID değeri: '${VPS_ID}'`);

        // Eğer zaten bağlı ise önce kapat
        if (this.ws) {
          try {
            this.ws.close();
          } catch (e) {
            // Hata yok sayılabilir
          }
          this.ws = null;
        }

        // Basit WebSocket bağlantısı kur
        this.ws = new WebSocket(ENDPOINT_URL);

        // Bağlantı açıldığında
        this.ws.onopen = () => {
          console.log("WebSocket bağlantısı başarıyla kuruldu!");
          this.isConnected = true;
          this.reconnectCount = 0; // Başarılı bağlantıda sayaç sıfırla

          // Welcome mesajını bekle, auth işlemini handleMessage içerisinde yapacağız
          console.log("Welcome mesajı bekleniyor...");

          resolve(true);
        };

        // Bağlantı kapandığında
        this.ws.onclose = () => {
          console.log("WebSocket bağlantısı kapandı, yeniden bağlanılacak...");
          this.isConnected = false;
          this.stopPingInterval();

          // Yeniden bağlanma
          this.scheduleReconnect();
        };

        // Hata oluştuğunda
        this.ws.onerror = (error) => {
          console.error("WebSocket bağlantı hatası:", error);
          this.isConnected = false;

          // İlk bağlantı denemesi başarısız olduysa
          if (!this.isConnected) {
            resolve(false);
          }
        };

        // Mesaj alındığında
        this.ws.onmessage = async (event) => {
          try {
            const message = JSON.parse(event.data);
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
   * WebSocket üzerinden mesaj gönder
   */
  private safeSend(data: any): boolean {
    if (!this.isConnected || !this.ws) {
      console.log(
        "WebSocket bağlı değil, mesaj gönderilemiyor:",
        JSON.stringify(data),
      );
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      console.log(
        `WebSocket hazır değil (Durum: ${this.ws.readyState}), mesaj gönderilemiyor:`,
        JSON.stringify(data),
      );
      return false;
    }

    try {
      // Her mesaja clientId ekle (zaten varsa değiştirme)
      if (data && typeof data === "object") {
        if (!data.data) data.data = {};
        if (!data.data.clientId && this.clientId) {
          data.data.clientId = this.clientId;
        }
        if (!data.data.vps_id && VPS_ID) {
          data.data.vps_id = VPS_ID;
        }
      }

      console.log("WebSocket mesajı gönderiliyor:", JSON.stringify(data));
      this.ws.send(JSON.stringify(data));
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
    this.safeSend({
      type: "auth",
      data: {
        vps_id: VPS_ID,
        token: CONNECTION_TOKEN,
        clientId: this.clientId,
      },
    });
  }

  /**
   * Durum mesajı gönder
   */
  public sendStatus(
    status: "connected" | "disconnected" | "busy" | "ready",
  ): void {
    this.safeSend({
      type: "status",
      data: {
        status,
        timestamp: new Date().toISOString(),
        clientId: this.clientId,
        vps_id: VPS_ID,
      },
    });
  }

  /**
   * Komut sonucunu gönder
   */
  public sendCommandResult(
    requestId: string,
    result: {
      success: boolean;
      output: string;
      error?: string;
      exit_code?: number;
    },
  ): void {
    this.safeSend({
      type: "command_result",
      data: {
        requestId,
        result: {
          success: result.success,
          output: result.output,
          error: result.error,
          exit_code: result.exit_code || 0,
        },
        timestamp: new Date().toISOString(),
        clientId: this.clientId,
        vps_id: VPS_ID,
      },
    });
  }

  /**
   * Gelen mesajları işle
   */
  private async handleMessage(message: any): Promise<void> {
    try {
      console.log(`Mesaj alındı: ${message.type}`);

      // Welcome mesajına yanıt ver
      if (message.type === "welcome") {
        console.log("Welcome mesajı alındı, oda ID:", message.data?.roomId);
        if (message.data?.roomId) {
          this.roomId = message.data.roomId;
        }
        if (message.data?.clientId) {
          this.clientId = message.data.clientId;
          console.log("Client ID alındı:", this.clientId);
        }
        // Auth mesajı gönder
        this.sendAuthMessage();
        return;
      }

      // Auth başarılı mesajı
      if (message.type === "auth_success") {
        console.log("Kimlik doğrulama başarılı!");
        // Ping interval başlat
        this.startPingInterval();
        // Durum mesajı gönder
        this.sendStatus("connected");
        return;
      }

      // Auth hata mesajı
      if (message.type === "auth_error") {
        console.error("Kimlik doğrulama hatası:", message.data?.message);
        this.disconnect();
        return;
      }

      // Ping mesajına yanıt ver
      if (message.type === "ping") {
        this.sendStatus("ready");
        return;
      }

      // Komut çalıştırma isteği
      if (message.type === "command") {
        console.log(`Komut alındı: ${message.data.command}`);

        // Meşgul durumunu bildir
        this.sendStatus("busy");

        // Komutu çalıştır
        const result = await executeCommand(
          message.data.command,
          message.data.requestId,
        );

        // Sonucu gönder
        this.sendCommandResult(message.data.requestId, result);

        // Hazır durumunu bildir
        this.sendStatus("ready");
        return;
      }

      console.log(`Bilinmeyen mesaj tipi: ${message.type}`);
    } catch (error) {
      console.error("Mesaj işleme hatası:", error);

      // Hata durumunda hazır olduğunu bildir
      this.sendStatus("ready");
    }
  }
}
