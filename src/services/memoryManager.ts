import { logger } from "./logger";

// Cache öğesi
interface CacheItem<T> {
  key: string;
  value: T;
  ttl: number; // Time to live in milliseconds
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  size: number; // Estimated size in bytes
}

// Cache konfigürasyonu
interface CacheConfig {
  maxSize: number; // Maximum cache size in bytes
  maxItems: number; // Maximum number of items
  defaultTTL: number; // Default TTL in milliseconds
  cleanupInterval: number; // Cleanup interval in milliseconds
  compressionEnabled: boolean;
  enableLRU: boolean; // Least Recently Used eviction
}

// Memory monitoring
interface MemoryMetrics {
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  cacheSize: number;
  cacheItems: number;
  gcCount: number;
  gcTime: number;
}

/**
 * Advanced Memory Manager with LRU Cache and Garbage Collection
 * Bellek kullanımını optimize eder ve akıllı önbellekleme sağlar
 */
export class MemoryManager<T = any> {
  private config: CacheConfig;
  private cache: Map<string, CacheItem<T>> = new Map();
  private accessOrder: string[] = []; // LRU tracking
  private cleanupInterval: NodeJS.Timeout | null = null;
  private currentSize: number = 0;
  private metrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    gcRuns: 0,
    averageResponseTime: 0,
  };
  private startTime: number = Date.now();

  constructor(config?: Partial<CacheConfig>) {
    this.config = {
      maxSize: 50 * 1024 * 1024, // 50MB
      maxItems: 10000,
      defaultTTL: 300000, // 5 minutes
      cleanupInterval: 30000, // 30 seconds
      compressionEnabled: false,
      enableLRU: true,
      ...config,
    };

    logger.info("Memory Manager initialized", {
      config: this.config,
      manager_id: this.generateManagerId(),
    });

    this.startCleanupCycle();
    this.startMemoryMonitoring();
  }

  private generateManagerId(): string {
    return `mem-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  }

  /**
   * Cache'e veri ekle
   */
  public set(key: string, value: T, ttl?: number): boolean {
    try {
      const now = Date.now();
      const itemTTL = ttl || this.config.defaultTTL;
      const estimatedSize = this.estimateSize(value);

      // Boyut kontrolü
      if (estimatedSize > this.config.maxSize) {
        logger.warn("Item too large for cache", {
          key,
          size: estimatedSize,
          max_size: this.config.maxSize,
        });
        return false;
      }

      // Mevcut item'ı kontrol et
      const existingItem = this.cache.get(key);
      if (existingItem) {
        this.currentSize -= existingItem.size;
        this.removeFromAccessOrder(key);
      }

      // Yer açma gerekiyor mu?
      while (
        (this.currentSize + estimatedSize > this.config.maxSize ||
          this.cache.size >= this.config.maxItems) &&
        this.cache.size > 0
      ) {
        this.evictLeastRecentlyUsed();
      }

      const cacheItem: CacheItem<T> = {
        key,
        value,
        ttl: itemTTL,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        size: estimatedSize,
      };

      this.cache.set(key, cacheItem);
      this.currentSize += estimatedSize;
      this.updateAccessOrder(key);

      logger.debug("Cache item set", {
        key,
        size: estimatedSize,
        ttl: itemTTL,
        cache_size: this.cache.size,
        memory_used: this.currentSize,
      });

      return true;
    } catch (error) {
      logger.error("Cache set failed", {
        key,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  /**
   * Cache'den veri al
   */
  public get(key: string): T | null {
    const startTime = Date.now();

    try {
      const item = this.cache.get(key);

      if (!item) {
        this.metrics.misses++;
        return null;
      }

      const now = Date.now();

      // TTL kontrolü
      if (now > item.createdAt + item.ttl) {
        this.delete(key);
        this.metrics.misses++;

        logger.debug("Cache item expired", {
          key,
          created_at: item.createdAt,
          ttl: item.ttl,
          expired_by: now - (item.createdAt + item.ttl),
        });

        return null;
      }

      // Hit kaydet
      this.metrics.hits++;
      item.lastAccessed = now;
      item.accessCount++;

      // LRU güncelle
      this.updateAccessOrder(key);

      const responseTime = Date.now() - startTime;
      this.updateAverageResponseTime(responseTime);

      logger.debug("Cache hit", {
        key,
        access_count: item.accessCount,
        age_ms: now - item.createdAt,
        response_time: responseTime,
      });

      return item.value;
    } catch (error) {
      logger.error("Cache get failed", {
        key,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  /**
   * Cache'den veri sil
   */
  public delete(key: string): boolean {
    try {
      const item = this.cache.get(key);
      if (!item) {
        return false;
      }

      this.cache.delete(key);
      this.currentSize -= item.size;
      this.removeFromAccessOrder(key);

      logger.debug("Cache item deleted", {
        key,
        size_freed: item.size,
        remaining_items: this.cache.size,
      });

      return true;
    } catch (error) {
      logger.error("Cache delete failed", {
        key,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  /**
   * Cache'i temizle
   */
  public clear(): void {
    const itemCount = this.cache.size;
    const sizeFreed = this.currentSize;

    this.cache.clear();
    this.accessOrder = [];
    this.currentSize = 0;

    logger.info("Cache cleared", {
      items_removed: itemCount,
      memory_freed: sizeFreed,
    });
  }

  private estimateSize(value: any): number {
    try {
      if (value === null || value === undefined) {
        return 8; // Reference size
      }

      if (typeof value === "string") {
        return value.length * 2; // UTF-16 encoding
      }

      if (typeof value === "number") {
        return 8; // 64-bit number
      }

      if (typeof value === "boolean") {
        return 4;
      }

      if (value instanceof ArrayBuffer) {
        return value.byteLength;
      }

      if (Array.isArray(value)) {
        return (
          value.reduce((sum, item) => sum + this.estimateSize(item), 0) + 24
        ); // Array overhead
      }

      if (typeof value === "object") {
        const jsonString = JSON.stringify(value);
        return jsonString.length * 2 + 24; // Object overhead
      }

      return 24; // Default overhead
    } catch (error) {
      logger.warn("Size estimation failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return 1024; // Conservative estimate
    }
  }

  private updateAccessOrder(key: string): void {
    if (!this.config.enableLRU) return;

    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  private evictLeastRecentlyUsed(): void {
    if (this.accessOrder.length === 0) {
      // LRU tracking yoksa, en eski item'ı sil
      const keys = Array.from(this.cache.keys());
      if (keys.length > 0) {
        this.delete(keys[0]);
        this.metrics.evictions++;
      }
      return;
    }

    const lruKey = this.accessOrder[0];
    this.delete(lruKey);
    this.metrics.evictions++;

    logger.debug("LRU eviction", {
      evicted_key: lruKey,
      remaining_items: this.cache.size,
    });
  }

  private updateAverageResponseTime(newTime: number): void {
    const totalRequests = this.metrics.hits + this.metrics.misses;
    const currentAverage = this.metrics.averageResponseTime;

    this.metrics.averageResponseTime =
      totalRequests === 1
        ? newTime
        : (currentAverage * (totalRequests - 1) + newTime) / totalRequests;
  }

  /**
   * Cleanup döngüsü başlat
   */
  private startCleanupCycle(): void {
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, this.config.cleanupInterval);

    logger.debug("Cleanup cycle started", {
      interval_ms: this.config.cleanupInterval,
    });
  }

  private performCleanup(): void {
    const startTime = Date.now();
    const initialSize = this.cache.size;
    let expiredCount = 0;
    const now = Date.now();

    // Expired items'ları temizle
    for (const [key, item] of this.cache.entries()) {
      if (now > item.createdAt + item.ttl) {
        this.delete(key);
        expiredCount++;
      }
    }

    // Memory pressure varsa ek temizlik yap
    const memoryUsage = process.memoryUsage();
    const heapUsagePercent =
      (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

    if (heapUsagePercent > 80) {
      this.performEmergencyCleanup();
    }

    this.metrics.gcRuns++;
    const cleanupTime = Date.now() - startTime;

    logger.debug("Cleanup completed", {
      expired_items: expiredCount,
      initial_size: initialSize,
      final_size: this.cache.size,
      cleanup_time_ms: cleanupTime,
      heap_usage_percent: heapUsagePercent,
    });
  }

  private performEmergencyCleanup(): void {
    const itemsToRemove = Math.floor(this.cache.size * 0.2); // %20'sini temizle
    let removedCount = 0;

    // En az kullanılan ve en eski item'ları öncelikle temizle
    const sortedItems = Array.from(this.cache.entries()).sort((a, b) => {
      const aScore = a[1].accessCount + (Date.now() - a[1].lastAccessed) / 1000;
      const bScore = b[1].accessCount + (Date.now() - b[1].lastAccessed) / 1000;
      return aScore - bScore;
    });

    for (const [key] of sortedItems) {
      if (removedCount >= itemsToRemove) break;
      this.delete(key);
      removedCount++;
    }

    logger.warn("Emergency cleanup performed", {
      items_removed: removedCount,
      reason: "high_memory_pressure",
    });
  }

  /**
   * Memory monitoring başlat
   */
  private startMemoryMonitoring(): void {
    setInterval(() => {
      this.reportMemoryMetrics();
    }, 60000); // 1 dakika
  }

  private reportMemoryMetrics(): void {
    const memoryUsage = process.memoryUsage();
    const cacheEfficiency =
      (this.metrics.hits /
        Math.max(1, this.metrics.hits + this.metrics.misses)) *
      100;

    const metrics: MemoryMetrics = {
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      external: memoryUsage.external,
      arrayBuffers: memoryUsage.arrayBuffers,
      rss: memoryUsage.rss,
      cacheSize: this.currentSize,
      cacheItems: this.cache.size,
      gcCount: this.metrics.gcRuns,
      gcTime: 0, // TODO: Track GC time
    };

    logger.performanceMetric("memory_usage", memoryUsage.heapUsed, "bytes", {
      memory_metrics: metrics,
      cache_efficiency: cacheEfficiency,
      cache_stats: this.getStats(),
    });
  }

  /**
   * Cache istatistikleri
   */
  public getStats() {
    const totalRequests = this.metrics.hits + this.metrics.misses;
    const hitRate =
      totalRequests > 0 ? (this.metrics.hits / totalRequests) * 100 : 0;
    const avgItemSize =
      this.cache.size > 0 ? this.currentSize / this.cache.size : 0;

    return {
      cache_size: this.cache.size,
      memory_used: this.currentSize,
      memory_limit: this.config.maxSize,
      memory_utilization: (this.currentSize / this.config.maxSize) * 100,
      hit_rate: hitRate,
      total_hits: this.metrics.hits,
      total_misses: this.metrics.misses,
      total_evictions: this.metrics.evictions,
      average_item_size: avgItemSize,
      average_response_time: this.metrics.averageResponseTime,
      gc_runs: this.metrics.gcRuns,
      uptime_ms: Date.now() - this.startTime,
    };
  }

  /**
   * Cache dump - debug için
   */
  public dump(): Array<{
    key: string;
    size: number;
    age: number;
    accessCount: number;
  }> {
    const now = Date.now();
    return Array.from(this.cache.entries()).map(([key, item]) => ({
      key,
      size: item.size,
      age: now - item.createdAt,
      accessCount: item.accessCount,
    }));
  }

  /**
   * Cleanup
   */
  public async cleanup(): Promise<void> {
    logger.info("Cleaning up memory manager", {
      cache_items: this.cache.size,
      memory_used: this.currentSize,
    });

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.clear();

    logger.info("Memory manager cleanup completed");
  }
}

// Result cache için özel wrapper
export class ResultCache extends MemoryManager<any> {
  constructor() {
    super({
      maxSize: 20 * 1024 * 1024, // 20MB for results
      maxItems: 5000,
      defaultTTL: 600000, // 10 minutes
      enableLRU: true,
    });
  }

  /**
   * Command result'ları cache'le
   */
  public cacheCommandResult(command: string, result: any, ttl?: number): void {
    const key = `cmd:${this.hashCommand(command)}`;
    this.set(key, result, ttl);
  }

  /**
   * Command result'ını al
   */
  public getCommandResult(command: string): any | null {
    const key = `cmd:${this.hashCommand(command)}`;
    return this.get(key);
  }

  private hashCommand(command: string): string {
    // Simple hash function for command
    let hash = 0;
    for (let i = 0; i < command.length; i++) {
      const char = command.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
}

// Singleton instances
export const memoryManager = new MemoryManager();
export const resultCache = new ResultCache();

export default memoryManager;
