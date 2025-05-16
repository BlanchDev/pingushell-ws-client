import { VPS_ID, TOKEN, ENDPOINT_URL } from "../config";
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

  /**
   * WebSocket bağlantısını oluştur
   */
  public async connect(): Promise<boolean> {
    try {
      return new Promise((resolve) => {
        console.log(`WebSocket bağlantısı kuruluyor: ${ENDPOINT_URL}`);
        console.log(`Token değeri: '${TOKEN}'`);
        console.log(`VPS ID değeri: '${VPS_ID}'`);

        // VPS ID ve TOKEN ile yetkilendirme bilgilerini URL'e ekle
        const url = `${ENDPOINT_URL}?token=${TOKEN}&vps_id=${VPS_ID}`;
        console.log(`Bağlantı URL'si: ${url}`);

        this.ws = new WebSocket(url);

        // Bağlantı açıldığında
        this.ws.onopen = () => {
          console.log("WebSocket bağlantısı başarıyla kuruldu!");
          this.isConnected = true;
          this.startPingInterval();

          // Bağlantı durumunu bildir
          this.sendStatus("connected");

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
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      console.log("WebSocket bağlantısı kapatıldı");
    }
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
      if (this.isConnected) {
        // Her 30 saniyede bir ping gönder
        this.send({ type: "ping" });
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
  private send(data: any): void {
    if (this.isConnected && this.ws) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Durum mesajı gönder
   */
  public sendStatus(
    status: "connected" | "disconnected" | "busy" | "ready",
  ): void {
    this.send({
      type: "status",
      data: {
        status,
        timestamp: new Date().toISOString(),
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
    this.send({
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
        vps_id: VPS_ID,
      },
    });
  }

  /**
   * Gelen mesajları işle
   */
  private async handleMessage(message: any): Promise<void> {
    try {
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
        const result = await executeCommand(message.data.command);

        // Sonucu gönder
        this.sendCommandResult(message.data.requestId, result);

        // Hazır durumunu bildir
        this.sendStatus("ready");
      }
    } catch (error) {
      console.error("Mesaj işleme hatası:", error);

      // Hata durumunda hazır olduğunu bildir
      this.sendStatus("ready");
    }
  }
}
