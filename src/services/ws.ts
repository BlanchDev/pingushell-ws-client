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

  /**
   * WebSocket bağlantısını başlat
   */
  public async connect(): Promise<boolean> {
    try {
      return new Promise((resolve) => {
        console.log(`WebSocket bağlantısı kuruluyor: ${ENDPOINT_URL}`);

        // WebSocket bağlantısı kur
        this.ws = new WebSocket(ENDPOINT_URL);

        // Bağlantı açıldığında
        this.ws.onopen = () => {
          console.log("WebSocket bağlantısı başarıyla kuruldu!");
          this.isConnected = true;

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
        this.sendStatus("disconnected");
        this.ws.close();
      } catch (error) {
        console.error("Bağlantı kapatma hatası:", error);
      }

      this.ws = null;
      this.isConnected = false;
      console.log("WebSocket bağlantısı kapatıldı");
    }
  }

  /**
   * Auth mesajı gönder
   */
  private sendAuthMessage(): void {
    if (!this.isConnected || !this.ws) return;

    console.log(`Auth mesajı gönderiliyor... VPS ID: ${VPS_ID}`);

    const authMessage = {
      type: "auth",
      data: {
        vps_id: VPS_ID,
        token: CONNECTION_TOKEN,
      },
    };

    this.ws.send(JSON.stringify(authMessage));
  }

  /**
   * Durum mesajı gönder
   */
  public sendStatus(
    status: "connected" | "disconnected" | "busy" | "ready",
  ): void {
    if (!this.isConnected || !this.ws) return;

    const statusMessage = {
      type: "status",
      data: {
        status,
        timestamp: new Date().toISOString(),
      },
    };

    this.ws.send(JSON.stringify(statusMessage));
  }

  /**
   * Yeniden bağlanma zamanlayıcısı
   */
  private scheduleReconnect(): void {
    if (!this.reconnectTimeout) {
      this.reconnectTimeout = setTimeout(async () => {
        this.reconnectTimeout = null;
        await this.connect();
      }, this.reconnectInterval);
    }
  }

  /**
   * Ping zamanlayıcısını başlat
   */
  private startPingInterval(): void {
    this.stopPingInterval();

    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws) {
        // Her 30 saniyede bir ping gönder
        this.ws.send(JSON.stringify({ type: "ping" }));
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
        console.log("Welcome mesajı alındı, oda ID:", message.data?.roomId);
        if (message.data?.roomId) {
          this.roomId = message.data.roomId;
        }
        // Auth mesajı gönder
        this.sendAuthMessage();
        break;

      case "ping":
        // Ping mesajına pong ile yanıt ver
        if (this.ws) {
          this.ws.send(JSON.stringify({ type: "pong" }));
        }
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
        if (message.data?.command && message.data?.requestId) {
          console.log(`Komut alındı: ${message.data.command}`);

          // Meşgul durumu bildir
          this.sendStatus("busy");

          try {
            // Komutu çalıştır
            const result = await executeCommand(
              message.data.command,
              message.data.requestId,
            );

            // Sonucu gönder
            if (this.ws) {
              this.ws.send(
                JSON.stringify({
                  type: "command_result",
                  data: {
                    requestId: message.data.requestId,
                    result: result.output,
                    exit_code: result.exit_code || 0,
                    timestamp: new Date().toISOString(),
                  },
                }),
              );
            }
          } catch (error) {
            console.error("Komut çalıştırma hatası:", error);

            if (this.ws) {
              this.ws.send(
                JSON.stringify({
                  type: "command_result",
                  data: {
                    requestId: message.data.requestId,
                    result: "Komut çalıştırma hatası oluştu",
                    error: String(error),
                    exit_code: 1,
                    timestamp: new Date().toISOString(),
                  },
                }),
              );
            }
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
