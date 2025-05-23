import WebSocket from "ws";
import { CONNECTION_TOKEN, VPS_ID, ENDPOINT_URL } from "../config";
import { logger } from "./logger";

// Connection pool konfigürasyonu
interface PoolConfig {
  maxConnections: number;
  connectionTimeout: number;
  healthCheckInterval: number;
  retryDelay: number;
  maxRetries: number;
}

// Bağlantı durumu
interface PooledConnection {
  id: string;
  ws: WebSocket;
  status: "connecting" | "connected" | "disconnected" | "error";
  lastUsed: number;
  createdAt: number;
  retryCount: number;
  isHealthy: boolean;
  metrics: {
    messagesReceived: number;
    messagesSent: number;
    errors: number;
    lastPing: number;
    lastPong: number;
  };
}

/**
 * Advanced WebSocket Connection Pool Manager
 * Bağlantıları verimli şekilde yönetir ve performansı optimize eder
 */
export class ConnectionPoolManager {
  private config: PoolConfig;
  private connections: Map<string, PooledConnection> = new Map();
  private activeConnection: string | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private connectionMetrics = {
    totalConnections: 0,
    successfulConnections: 0,
    failedConnections: 0,
    totalReconnects: 0,
    averageConnectionTime: 0,
  };

  constructor(config?: Partial<PoolConfig>) {
    this.config = {
      maxConnections: 3, // Aynı anda max 3 bağlantı
      connectionTimeout: 10000, // 10 saniye
      healthCheckInterval: 15000, // 15 saniye
      retryDelay: 5000, // 5 saniye
      maxRetries: 5,
      ...config,
    };

    logger.info("Connection Pool initialized", {
      config: this.config,
      pool_id: this.generatePoolId(),
    });

    this.startHealthCheckCycle();
  }

  private generatePoolId(): string {
    return `pool-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  }

  private generateConnectionId(): string {
    return `conn-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
  }

  /**
   * Yeni bağlantı oluştur
   */
  private async createConnection(): Promise<PooledConnection | null> {
    const connectionId = this.generateConnectionId();
    const startTime = Date.now();

    try {
      logger.debug("Creating new pooled connection", {
        connection_id: connectionId,
        endpoint: ENDPOINT_URL,
        current_pool_size: this.connections.size,
      });

      const ws = new WebSocket(ENDPOINT_URL);

      const connection: PooledConnection = {
        id: connectionId,
        ws,
        status: "connecting",
        lastUsed: Date.now(),
        createdAt: Date.now(),
        retryCount: 0,
        isHealthy: false,
        metrics: {
          messagesReceived: 0,
          messagesSent: 0,
          errors: 0,
          lastPing: 0,
          lastPong: 0,
        },
      };

      // Promise ile bağlantı sonucunu bekle
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          this.connectionMetrics.failedConnections++;
          logger.warn("Connection timeout", {
            connection_id: connectionId,
            timeout_ms: this.config.connectionTimeout,
          });
          reject(new Error("Connection timeout"));
        }, this.config.connectionTimeout);

        ws.onopen = () => {
          clearTimeout(timeout);
          connection.status = "connected";
          connection.isHealthy = true;
          this.connectionMetrics.successfulConnections++;

          const connectionTime = Date.now() - startTime;
          this.updateAverageConnectionTime(connectionTime);

          logger.info("Pooled connection established", {
            connection_id: connectionId,
            connection_time_ms: connectionTime,
            pool_size: this.connections.size + 1,
          });

          this.connections.set(connectionId, connection);
          resolve(connection);
        };

        ws.onerror = (error) => {
          clearTimeout(timeout);
          connection.status = "error";
          connection.isHealthy = false;
          connection.metrics.errors++;
          this.connectionMetrics.failedConnections++;

          logger.error("Pooled connection error", {
            connection_id: connectionId,
            error: error.message,
            retry_count: connection.retryCount,
          });

          reject(error);
        };

        ws.onclose = () => {
          connection.status = "disconnected";
          connection.isHealthy = false;

          logger.debug("Pooled connection closed", {
            connection_id: connectionId,
            was_active: this.activeConnection === connectionId,
          });

          // Aktif bağlantıysa yeni bir tane bul
          if (this.activeConnection === connectionId) {
            this.activeConnection = null;
            this.findBestConnection();
          }

          this.connections.delete(connectionId);
        };

        ws.onmessage = (event) => {
          connection.metrics.messagesReceived++;
          connection.lastUsed = Date.now();

          // Pong mesajlarını takip et
          try {
            const message = JSON.parse(event.data.toString());
            if (message.type === "pong") {
              connection.metrics.lastPong = Date.now();
            }
          } catch (e) {
            // JSON parse hatası önemli değil
          }
        };
      });
    } catch (error) {
      this.connectionMetrics.failedConnections++;
      logger.error("Connection creation failed", {
        connection_id: connectionId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  private updateAverageConnectionTime(newTime: number): void {
    const totalConnections = this.connectionMetrics.successfulConnections;
    const currentAverage = this.connectionMetrics.averageConnectionTime;

    this.connectionMetrics.averageConnectionTime =
      (currentAverage * (totalConnections - 1) + newTime) / totalConnections;
  }

  /**
   * En iyi bağlantıyı bul ve aktif yap
   */
  private findBestConnection(): PooledConnection | null {
    const healthyConnections = Array.from(this.connections.values()).filter(
      (conn) => conn.isHealthy && conn.status === "connected",
    );

    if (healthyConnections.length === 0) {
      logger.warn("No healthy connections available in pool");
      return null;
    }

    // En az kullanılan ve en sağlıklı bağlantıyı seç
    const bestConnection = healthyConnections.reduce((best, current) => {
      const bestScore = this.calculateConnectionScore(best);
      const currentScore = this.calculateConnectionScore(current);
      return currentScore > bestScore ? current : best;
    });

    this.activeConnection = bestConnection.id;
    bestConnection.lastUsed = Date.now();

    logger.debug("Best connection selected", {
      connection_id: bestConnection.id,
      score: this.calculateConnectionScore(bestConnection),
      pool_size: this.connections.size,
    });

    return bestConnection;
  }

  private calculateConnectionScore(connection: PooledConnection): number {
    const now = Date.now();
    const age = now - connection.createdAt;
    const idleTime = now - connection.lastUsed;
    const errorRate =
      connection.metrics.errors /
      Math.max(1, connection.metrics.messagesReceived);

    // Skor: düşük hata oranı + düşük idle time + makul yaş
    const ageScore = Math.max(0, 100 - age / 60000); // 1 dakika sonra azalmaya başlar
    const idleScore = Math.max(0, 100 - idleTime / 30000); // 30 saniye idle'dan sonra azalır
    const errorScore = Math.max(0, 100 - errorRate * 100);

    return (ageScore + idleScore + errorScore) / 3;
  }

  /**
   * Aktif bağlantı al veya yeni oluştur
   */
  public async getConnection(): Promise<PooledConnection | null> {
    // Mevcut aktif bağlantı var mı?
    if (this.activeConnection) {
      const connection = this.connections.get(this.activeConnection);
      if (
        connection &&
        connection.isHealthy &&
        connection.status === "connected"
      ) {
        connection.lastUsed = Date.now();
        return connection;
      }
    }

    // En iyi mevcut bağlantıyı bul
    const bestConnection = this.findBestConnection();
    if (bestConnection) {
      return bestConnection;
    }

    // Yeni bağlantı oluştur (eğer limit aşılmadıysa)
    if (this.connections.size < this.config.maxConnections) {
      logger.info("Creating new connection for pool", {
        current_size: this.connections.size,
        max_size: this.config.maxConnections,
      });

      const newConnection = await this.createConnection();
      if (newConnection) {
        this.activeConnection = newConnection.id;
        return newConnection;
      }
    }

    logger.warn("No connections available and pool is full", {
      pool_size: this.connections.size,
      max_connections: this.config.maxConnections,
    });

    return null;
  }

  /**
   * Güvenli mesaj gönderme
   */
  public async sendMessage(data: any): Promise<boolean> {
    const connection = await this.getConnection();
    if (!connection) {
      logger.error("Cannot send message: no connection available");
      return false;
    }

    try {
      const jsonData = JSON.stringify(data);
      connection.ws.send(jsonData);
      connection.metrics.messagesSent++;
      connection.lastUsed = Date.now();

      logger.debug("Message sent via pool", {
        connection_id: connection.id,
        message_type: data.type,
        message_size: jsonData.length,
      });

      return true;
    } catch (error) {
      connection.metrics.errors++;
      logger.error("Message send failed", {
        connection_id: connection.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Bu bağlantıyı sağlıksız olarak işaretle
      connection.isHealthy = false;
      if (this.activeConnection === connection.id) {
        this.activeConnection = null;
      }

      return false;
    }
  }

  /**
   * Bağlantı sağlık kontrolü döngüsü
   */
  private startHealthCheckCycle(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);

    logger.debug("Health check cycle started", {
      interval_ms: this.config.healthCheckInterval,
    });
  }

  private async performHealthCheck(): Promise<void> {
    const now = Date.now();
    const connectionsToRemove: string[] = [];

    logger.debug("Performing pool health check", {
      pool_size: this.connections.size,
      active_connection: this.activeConnection,
    });

    for (const [connectionId, connection] of this.connections) {
      // Bağlantı durumunu kontrol et
      if (
        connection.status !== "connected" ||
        connection.ws.readyState !== WebSocket.OPEN
      ) {
        connection.isHealthy = false;
        connectionsToRemove.push(connectionId);
        continue;
      }

      // Ping/Pong kontrolü
      const timeSinceLastPong = now - connection.metrics.lastPong;
      if (connection.metrics.lastPing > 0 && timeSinceLastPong > 60000) {
        logger.warn("Connection ping timeout", {
          connection_id: connectionId,
          time_since_pong: timeSinceLastPong,
        });
        connection.isHealthy = false;
        connectionsToRemove.push(connectionId);
        continue;
      }

      // Ping gönder
      try {
        connection.ws.send(JSON.stringify({ type: "ping" }));
        connection.metrics.lastPing = now;
      } catch (error) {
        logger.error("Ping failed", {
          connection_id: connectionId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        connection.isHealthy = false;
        connectionsToRemove.push(connectionId);
      }
    }

    // Sağlıksız bağlantıları temizle
    for (const connectionId of connectionsToRemove) {
      await this.removeConnection(connectionId);
    }

    // Performans metrikleri raporu
    this.reportHealthMetrics();
  }

  private async removeConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    logger.debug("Removing unhealthy connection", {
      connection_id: connectionId,
      status: connection.status,
      metrics: connection.metrics,
    });

    try {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close();
      }
    } catch (error) {
      logger.warn("Error closing connection", {
        connection_id: connectionId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    this.connections.delete(connectionId);

    // Aktif bağlantıysa yenisini bul
    if (this.activeConnection === connectionId) {
      this.activeConnection = null;
      this.findBestConnection();
    }
  }

  private reportHealthMetrics(): void {
    const healthyCount = Array.from(this.connections.values()).filter(
      (conn) => conn.isHealthy,
    ).length;

    const totalMessages = Array.from(this.connections.values()).reduce(
      (sum, conn) =>
        sum + conn.metrics.messagesSent + conn.metrics.messagesReceived,
      0,
    );

    const totalErrors = Array.from(this.connections.values()).reduce(
      (sum, conn) => sum + conn.metrics.errors,
      0,
    );

    logger.performanceMetric(
      "connection_pool_health",
      healthyCount,
      "connections",
      {
        total_connections: this.connections.size,
        healthy_connections: healthyCount,
        active_connection: this.activeConnection,
        total_messages: totalMessages,
        total_errors: totalErrors,
        pool_metrics: this.connectionMetrics,
      },
    );
  }

  /**
   * Tüm bağlantıları temizle
   */
  public async cleanup(): Promise<void> {
    logger.info("Cleaning up connection pool", {
      connections_to_close: this.connections.size,
    });

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    const closePromises = Array.from(this.connections.keys()).map(
      (connectionId) => this.removeConnection(connectionId),
    );

    await Promise.all(closePromises);
    this.activeConnection = null;

    logger.info("Connection pool cleanup completed");
  }

  /**
   * Pool istatistikleri
   */
  public getStats() {
    const connections = Array.from(this.connections.values());
    const healthyConnections = connections.filter((conn) => conn.isHealthy);

    return {
      pool_size: this.connections.size,
      healthy_connections: healthyConnections.length,
      active_connection: this.activeConnection,
      metrics: this.connectionMetrics,
      connections: connections.map((conn) => ({
        id: conn.id,
        status: conn.status,
        isHealthy: conn.isHealthy,
        lastUsed: conn.lastUsed,
        metrics: conn.metrics,
      })),
    };
  }
}

// Singleton pool instance
export const connectionPool = new ConnectionPoolManager();

export default connectionPool;
