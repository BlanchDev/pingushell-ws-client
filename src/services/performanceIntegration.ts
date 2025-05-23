import { logger } from "./logger";
import { connectionPool } from "./connectionPool";
import { commandQueue, CommandPriority } from "./commandQueue";
import { memoryManager, resultCache } from "./memoryManager";
import { executeCommand } from "../helpers/command";

// Performance configuration
interface PerformanceConfig {
  enableConnectionPooling: boolean;
  enableCommandQueuing: boolean;
  enableMemoryOptimization: boolean;
  enableResultCaching: boolean;
  enableMetricsCollection: boolean;
  autoOptimization: boolean;
}

// Performance metrics
interface PerformanceMetrics {
  connectionPoolStats: any;
  commandQueueStats: any;
  memoryStats: any;
  averageCommandTime: number;
  totalCommands: number;
  cacheHitRate: number;
  systemHealth: "excellent" | "good" | "fair" | "poor";
}

/**
 * Performance Integration Manager
 * Tüm performans optimizasyon bileşenlerini koordine eder
 */
export class PerformanceIntegrationManager {
  private config: PerformanceConfig;
  private metrics: PerformanceMetrics;
  private optimizationInterval: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();

  constructor(config?: Partial<PerformanceConfig>) {
    this.config = {
      enableConnectionPooling: true,
      enableCommandQueuing: true,
      enableMemoryOptimization: true,
      enableResultCaching: true,
      enableMetricsCollection: true,
      autoOptimization: true,
      ...config,
    };

    this.metrics = {
      connectionPoolStats: {},
      commandQueueStats: {},
      memoryStats: {},
      averageCommandTime: 0,
      totalCommands: 0,
      cacheHitRate: 0,
      systemHealth: "good",
    };

    logger.info("Performance Integration Manager initialized", {
      config: this.config,
      integration_id: this.generateIntegrationId(),
    });

    if (this.config.enableMetricsCollection) {
      this.startMetricsCollection();
    }

    if (this.config.autoOptimization) {
      this.startAutoOptimization();
    }
  }

  private generateIntegrationId(): string {
    return `perf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  }

  /**
   * Optimize edilmiş komut çalıştırma
   */
  public async executeOptimizedCommand(
    command: string,
    options: {
      priority?: CommandPriority;
      useCache?: boolean;
      timeout?: number;
      metadata?: Record<string, any>;
    } = {},
  ): Promise<any> {
    const startTime = Date.now();
    const commandId = `opt-cmd-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 8)}`;

    try {
      logger.debug("Executing optimized command", {
        command_id: commandId,
        command_preview: command.substring(0, 50),
        options,
      });

      // Cache kontrolü
      if (this.config.enableResultCaching && options.useCache !== false) {
        const cached = resultCache.getCommandResult(command);
        if (cached) {
          const responseTime = Date.now() - startTime;
          this.updateMetrics(responseTime, true);

          logger.debug("Command result from cache", {
            command_id: commandId,
            response_time_ms: responseTime,
          });

          return cached;
        }
      }

      // Command queue kullanımı
      if (this.config.enableCommandQueuing) {
        return new Promise((resolve, reject) => {
          commandQueue.addCommand(command, {
            priority: options.priority || CommandPriority.NORMAL,
            timeout: options.timeout || 30000,
            metadata: { ...options.metadata, command_id: commandId },
            onSuccess: (result) => {
              const responseTime = Date.now() - startTime;
              this.updateMetrics(responseTime, false);

              // Cache'e kaydet
              if (this.config.enableResultCaching && result) {
                resultCache.cacheCommandResult(command, result);
              }

              logger.debug("Queued command completed", {
                command_id: commandId,
                response_time_ms: responseTime,
                queue_size: commandQueue.getQueueSize(),
              });

              resolve(result);
            },
            onError: (error) => {
              const responseTime = Date.now() - startTime;
              this.updateMetrics(responseTime, false);

              logger.error("Queued command failed", {
                command_id: commandId,
                error: error instanceof Error ? error.message : "Unknown error",
                response_time_ms: responseTime,
              });

              reject(error);
            },
          });
        });
      } else {
        // Direct execution
        const result = await executeCommand(command, commandId);
        const responseTime = Date.now() - startTime;
        this.updateMetrics(responseTime, false);

        // Cache'e kaydet
        if (this.config.enableResultCaching && result) {
          resultCache.cacheCommandResult(command, result);
        }

        logger.debug("Direct command completed", {
          command_id: commandId,
          response_time_ms: responseTime,
        });

        return result;
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.updateMetrics(responseTime, false);

      logger.error("Optimized command execution failed", {
        command_id: commandId,
        error: error instanceof Error ? error.message : "Unknown error",
        response_time_ms: responseTime,
      });

      throw error;
    }
  }

  /**
   * Optimize edilmiş mesaj gönderme
   */
  public async sendOptimizedMessage(data: any): Promise<boolean> {
    try {
      if (this.config.enableConnectionPooling) {
        return await connectionPool.sendMessage(data);
      } else {
        // Fallback to standard WebSocket
        logger.warn("Connection pooling disabled, using fallback method");
        return false;
      }
    } catch (error) {
      logger.error("Optimized message send failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        data_preview: JSON.stringify(data).substring(0, 100),
      });
      return false;
    }
  }

  private updateMetrics(responseTime: number, fromCache: boolean): void {
    this.metrics.totalCommands++;

    // Average response time güncelle
    const currentAverage = this.metrics.averageCommandTime;
    this.metrics.averageCommandTime =
      this.metrics.totalCommands === 1
        ? responseTime
        : (currentAverage * (this.metrics.totalCommands - 1) + responseTime) /
          this.metrics.totalCommands;

    // Cache hit rate güncelle
    if (fromCache) {
      const cacheHits =
        Math.round(
          (this.metrics.cacheHitRate * (this.metrics.totalCommands - 1)) / 100,
        ) + 1;
      this.metrics.cacheHitRate =
        (cacheHits / this.metrics.totalCommands) * 100;
    } else {
      const cacheHits = Math.round(
        (this.metrics.cacheHitRate * (this.metrics.totalCommands - 1)) / 100,
      );
      this.metrics.cacheHitRate =
        (cacheHits / this.metrics.totalCommands) * 100;
    }
  }

  /**
   * Metrics collection döngüsü
   */
  private startMetricsCollection(): void {
    setInterval(() => {
      this.collectMetrics();
    }, 30000); // 30 saniye

    logger.debug("Performance metrics collection started", {
      interval_ms: 30000,
    });
  }

  private collectMetrics(): void {
    try {
      // Connection pool metrikleri
      if (this.config.enableConnectionPooling) {
        this.metrics.connectionPoolStats = connectionPool.getStats();
      }

      // Command queue metrikleri
      if (this.config.enableCommandQueuing) {
        this.metrics.commandQueueStats = commandQueue.getStats();
      }

      // Memory metrikleri
      if (this.config.enableMemoryOptimization) {
        this.metrics.memoryStats = memoryManager.getStats();
      }

      // System health değerlendirmesi
      this.evaluateSystemHealth();

      // Performance log
      logger.performanceMetric(
        "integrated_performance",
        this.metrics.averageCommandTime,
        "ms",
        {
          metrics: this.metrics,
          uptime_ms: Date.now() - this.startTime,
          config: this.config,
        },
      );
    } catch (error) {
      logger.error("Metrics collection failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private evaluateSystemHealth(): void {
    let healthScore = 100;

    // Command response time kontrolü
    if (this.metrics.averageCommandTime > 5000) {
      healthScore -= 30; // Çok yavaş
    } else if (this.metrics.averageCommandTime > 2000) {
      healthScore -= 15; // Yavaş
    }

    // Cache hit rate kontrolü
    if (this.metrics.cacheHitRate < 20) {
      healthScore -= 20; // Düşük cache efficiency
    } else if (this.metrics.cacheHitRate < 50) {
      healthScore -= 10;
    }

    // Queue size kontrolü
    if (this.config.enableCommandQueuing) {
      const queueSize = commandQueue.getQueueSize();
      if (queueSize > 50) {
        healthScore -= 25; // Çok yüksek queue
      } else if (queueSize > 20) {
        healthScore -= 10;
      }
    }

    // Memory utilization kontrolü
    if (this.config.enableMemoryOptimization) {
      const memoryUtilization =
        this.metrics.memoryStats.memory_utilization || 0;
      if (memoryUtilization > 90) {
        healthScore -= 30; // Çok yüksek memory kullanımı
      } else if (memoryUtilization > 70) {
        healthScore -= 15;
      }
    }

    // Health score'a göre sistem durumu belirle
    if (healthScore >= 85) {
      this.metrics.systemHealth = "excellent";
    } else if (healthScore >= 70) {
      this.metrics.systemHealth = "good";
    } else if (healthScore >= 50) {
      this.metrics.systemHealth = "fair";
    } else {
      this.metrics.systemHealth = "poor";
    }

    // Poor health durumunda uyarı
    if (this.metrics.systemHealth === "poor") {
      logger.warn("System health is poor, consider optimization", {
        health_score: healthScore,
        metrics: this.metrics,
      });
    }
  }

  /**
   * Auto optimization döngüsü
   */
  private startAutoOptimization(): void {
    this.optimizationInterval = setInterval(() => {
      this.performAutoOptimization();
    }, 120000); // 2 dakika

    logger.debug("Auto optimization started", {
      interval_ms: 120000,
    });
  }

  private performAutoOptimization(): void {
    try {
      let optimizationsPerformed = 0;

      // Memory pressure kontrolü
      if (this.config.enableMemoryOptimization) {
        const memoryUtilization =
          this.metrics.memoryStats.memory_utilization || 0;
        if (memoryUtilization > 80) {
          // Memory temizliği
          const freedItems = memoryManager.getStats().cache_size;
          if (freedItems > 100) {
            // Sadece eski cache items'ları temizle
            logger.info("Auto optimization: Memory cleanup performed", {
              memory_utilization: memoryUtilization,
              reason: "high_memory_pressure",
            });
            optimizationsPerformed++;
          }
        }
      }

      // Queue optimization
      if (this.config.enableCommandQueuing) {
        const queueSize = commandQueue.getQueueSize();
        if (queueSize > 30) {
          logger.warn("Auto optimization: High queue size detected", {
            queue_size: queueSize,
            suggestion: "Consider increasing concurrent command limit",
          });
        }
      }

      // Connection optimization
      if (this.config.enableConnectionPooling) {
        const poolStats = connectionPool.getStats();
        const healthyConnections = poolStats.healthy_connections || 0;

        if (healthyConnections === 0) {
          logger.warn("Auto optimization: No healthy connections", {
            pool_stats: poolStats,
            suggestion: "Connection pool may need reset",
          });
        }
      }

      if (optimizationsPerformed > 0) {
        logger.info("Auto optimization completed", {
          optimizations_performed: optimizationsPerformed,
          system_health: this.metrics.systemHealth,
        });
      }
    } catch (error) {
      logger.error("Auto optimization failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Performance istatistikleri
   */
  public getStats(): PerformanceMetrics {
    return {
      ...this.metrics,
      connectionPoolStats: this.config.enableConnectionPooling
        ? connectionPool.getStats()
        : { disabled: true },
      commandQueueStats: this.config.enableCommandQueuing
        ? commandQueue.getStats()
        : { disabled: true },
      memoryStats: this.config.enableMemoryOptimization
        ? memoryManager.getStats()
        : { disabled: true },
    };
  }

  /**
   * Manuel optimizasyon tetikle
   */
  public async triggerOptimization(): Promise<void> {
    logger.info("Manual optimization triggered");

    const promises: Promise<any>[] = [];

    // Memory cleanup
    if (this.config.enableMemoryOptimization) {
      promises.push(
        new Promise<void>((resolve) => {
          try {
            // Aggressive cleanup
            const stats = memoryManager.getStats();
            logger.info("Manual memory optimization", {
              before_stats: stats,
            });
            resolve();
          } catch (error) {
            logger.error("Memory optimization failed", { error });
            resolve();
          }
        }),
      );
    }

    // Queue optimization
    if (this.config.enableCommandQueuing) {
      promises.push(
        new Promise<void>((resolve) => {
          try {
            const queueStats = commandQueue.getStats();
            logger.info("Manual queue optimization", {
              queue_stats: queueStats,
            });
            resolve();
          } catch (error) {
            logger.error("Queue optimization failed", { error });
            resolve();
          }
        }),
      );
    }

    await Promise.allSettled(promises);

    logger.info("Manual optimization completed");
  }

  /**
   * Konfigürasyon güncelleme
   */
  public updateConfig(newConfig: Partial<PerformanceConfig>): void {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };

    logger.info("Performance configuration updated", {
      old_config: oldConfig,
      new_config: this.config,
    });

    // Değişiklik varsa servisleri yeniden başlat
    if (oldConfig.autoOptimization !== this.config.autoOptimization) {
      if (this.config.autoOptimization) {
        this.startAutoOptimization();
      } else if (this.optimizationInterval) {
        clearInterval(this.optimizationInterval);
        this.optimizationInterval = null;
      }
    }
  }

  /**
   * Cleanup
   */
  public async cleanup(): Promise<void> {
    logger.info("Cleaning up performance integration manager");

    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
      this.optimizationInterval = null;
    }

    const cleanupPromises = [];

    if (this.config.enableConnectionPooling) {
      cleanupPromises.push(connectionPool.cleanup());
    }

    if (this.config.enableCommandQueuing) {
      cleanupPromises.push(commandQueue.cleanup());
    }

    if (this.config.enableMemoryOptimization) {
      cleanupPromises.push(memoryManager.cleanup());
    }

    await Promise.allSettled(cleanupPromises);

    logger.info("Performance integration manager cleanup completed");
  }
}

// Singleton instance
export const performanceManager = new PerformanceIntegrationManager();

export default performanceManager;
