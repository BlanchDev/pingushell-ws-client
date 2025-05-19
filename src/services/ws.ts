import WebSocket from "ws";
import { CONNECTION_TOKEN, VPS_ID, ENDPOINT_URL, ROOM_ID } from "../config";
import { executeCommand } from "../helpers/command";

export class WebSocketClient {
  private ws: WebSocket | null = null;
  public isConnected: boolean = false;
  private reconnectInterval: number = 5000; // 5 saniye
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private roomId: string = ROOM_ID || ""; // Oda ID'sini değişkenden al
  private clientId: string = ""; // Client ID'yi sakla
  private reconnectCount: number = 0;
  private maxReconnectAttempts: number = 10;
  private lastPingTime: number = 0;
  private lastPongTime: number = 0;
  private connectionHealthCheckInterval: NodeJS.Timeout | null = null;
  private manualDisconnect: boolean = false; // Bağlantının manuel olarak kapatıldığını belirtmek için

  /**
   * WebSocket bağlantısını başlat
   */
  public async connect(): Promise<boolean> {
    try {
      // Eğer manuel disconnect yapıldıysa, yeniden bağlanmayı durdur
      if (this.manualDisconnect) {
        console.log("Manuel disconnect sonrası yeniden bağlanma devre dışı");
        return false;
      }

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

          // Sağlık durumu kontrolü başlat
          this.startHealthCheck();

          resolve(true);
        };

        // Bağlantı kapandığında
        this.ws.onclose = (event) => {
          console.log(
            `WebSocket bağlantısı kapandı (Kod: ${event.code}), yeniden bağlanılacak...`,
          );
          this.isConnected = false;
          this.stopPingInterval();
          this.stopHealthCheck();

          // Eğer manuel disconnect yapılmadıysa yeniden bağlan
          if (!this.manualDisconnect) {
            // Yeniden bağlanma
            this.scheduleReconnect();
          } else {
            console.log("Manuel disconnect yapıldı, yeniden bağlanılmayacak");
          }
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
  public disconnect(manual: boolean = true): void {
    this.manualDisconnect = manual;
    this.stopPingInterval();
    this.stopHealthCheck();

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

      // Bağlantı hazır değilse, yeniden bağlanmayı dene
      if (
        this.ws.readyState === WebSocket.CLOSED ||
        this.ws.readyState === WebSocket.CLOSING
      ) {
        console.log(
          "WebSocket kapalı veya kapanıyor, yeniden bağlanmayı deneyeceğiz",
        );
        this.isConnected = false;
        this.manualDisconnect = false; // Yeniden bağlanmayı etkinleştir
        this.scheduleReconnect();
      }

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

      // Eğer ping mesajı gönderiyorsak, son ping zamanını güncelle
      if (data && data.type === "ping") {
        this.lastPingTime = Date.now();
      }

      return true;
    } catch (error) {
      console.error("Mesaj gönderme hatası:", error);
      return false;
    }
  }

  /**
   * Bağlantı sağlık kontrolü başlat
   */
  private startHealthCheck(): void {
    this.stopHealthCheck();

    this.connectionHealthCheckInterval = setInterval(() => {
      if (!this.isConnected || !this.ws) {
        return;
      }

      // WebSocket durumunu kontrol et
      if (this.ws.readyState !== WebSocket.OPEN) {
        console.log(
          `WebSocket sağlıklı değil (Durum: ${this.ws.readyState}), yeniden bağlanma başlatılıyor`,
        );
        this.disconnect(false); // Manuel olmayan disconnect
        this.scheduleReconnect();
        return;
      }

      // Ping/Pong kontrolü - Son ping'ten 60 saniye geçtiyse ve pong alınmadıysa
      const pingTimeout = 60000; // 60 saniye
      if (
        this.lastPingTime > 0 &&
        Date.now() - this.lastPingTime > pingTimeout &&
        (this.lastPongTime === 0 || this.lastPingTime > this.lastPongTime)
      ) {
        console.log(
          `Ping-pong zaman aşımı, ${pingTimeout}ms içinde yanıt alınamadı, yeniden bağlanma başlatılıyor`,
        );
        this.disconnect(false); // Manuel olmayan disconnect
        this.scheduleReconnect();
        return;
      }

      // Ekstra ping gönder (açık kalsın diye)
      this.safeSend({ type: "ping" });
    }, 15000); // 15 saniyede bir kontrol et
  }

  /**
   * Sağlık kontrolünü durdur
   */
  private stopHealthCheck(): void {
    if (this.connectionHealthCheckInterval) {
      clearInterval(this.connectionHealthCheckInterval);
      this.connectionHealthCheckInterval = null;
    }
  }

  /**
   * Auth mesajı gönder
   */
  private sendAuthMessage(): void {
    if (!this.isConnected || !this.ws) {
      console.log("WebSocket bağlı değil, auth mesajı gönderilemiyor");
      return;
    }

    // Auth mesajı gönder
    console.log(
      `Auth mesajı gönderiliyor... VPS ID: ${VPS_ID}, Client ID: ${this.clientId}`,
    );
    this.safeSend({
      type: "auth",
      data: {
        vps_id: VPS_ID,
        token: CONNECTION_TOKEN,
        clientId: this.clientId,
        room_id: this.roomId, // Oda ID'sini ekle
      },
    });
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
      } else if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        console.log(
          "Ping interval: WebSocket hazır değil, yeniden bağlanmayı deneyeceğiz",
        );
        this.disconnect(false); // Manuel olmayan disconnect
        this.scheduleReconnect();
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
        // Pong mesajı alındı, son pong zamanını güncelle
        this.lastPongTime = Date.now();
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

            console.log(
              `Komut çalıştırıldı. Çıkış kodu: ${result.exit_code}, Sonuç uzunluğu: ${result.output.length}`,
            );

            // Eğer hata varsa loglayalım
            if (result.exit_code !== 0) {
              console.error(
                `Komut hata ile tamamlandı! Çıkış kodu: ${result.exit_code}`,
              );
              console.error(`Hata çıktısı: ${result.error || "Yok"}`);
            }

            // Sonucu gönder
            const success = this.safeSend({
              type: "command_result",
              data: {
                command_id: message.data.command_id,
                result: result.output,
                exit_code: result.exit_code || 0,
                timestamp: new Date().toISOString(),
              },
            });

            if (!success) {
              console.error(
                "Komut sonucu gönderilemedi, WebSocket bağlantısı problemli olabilir",
              );
            }
          } catch (error) {
            console.error("Komut çalıştırma hatası:", error);

            // Hata sonucunu göndermeyi dene
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
        } else {
          console.error("Eksik komut bilgisi:", message.data);
        }
        break;

      default:
        console.log(`Bilinmeyen mesaj tipi: ${message.type}`);
    }
  }
}
