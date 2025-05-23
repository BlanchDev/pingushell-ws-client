import { logger } from "./logger";
import { executeCommand } from "../helpers/command";

// Komut öncelik seviyeleri
export enum CommandPriority {
  LOW = 1,
  NORMAL = 2,
  HIGH = 3,
  CRITICAL = 4,
}

// Komut kuyruk öğesi
interface QueuedCommand {
  id: string;
  command: string;
  priority: CommandPriority;
  addedAt: number;
  attempts: number;
  maxAttempts: number;
  timeout: number;
  metadata?: Record<string, any>;
  onSuccess?: (result: any) => void;
  onError?: (error: any) => void;
  onProgress?: (progress: any) => void;
}

// Batch işlem öğesi
interface CommandBatch {
  id: string;
  commands: QueuedCommand[];
  priority: CommandPriority;
  createdAt: number;
  status: "pending" | "processing" | "completed" | "failed";
}

// Queue konfigürasyonu
interface QueueConfig {
  maxQueueSize: number;
  maxConcurrentCommands: number;
  batchSize: number;
  batchTimeout: number;
  retryDelay: number;
  priorityBoostThreshold: number; // Queue'da ne kadar beklerse priority artırılacak
  performanceOptimization: boolean;
}

/**
 * Advanced Command Queue Manager
 * Komutları öncelik bazlı, batch'leyerek ve performansı optimize ederek işler
 */
export class CommandQueueManager {
  private config: QueueConfig;
  private queue: QueuedCommand[] = [];
  private processingQueue: Set<string> = new Set();
  private batches: Map<string, CommandBatch> = new Map();
  private processingInterval: NodeJS.Timeout | null = null;
  private batchInterval: NodeJS.Timeout | null = null;
  private metrics = {
    totalCommands: 0,
    completedCommands: 0,
    failedCommands: 0,
    averageExecutionTime: 0,
    averageQueueTime: 0,
    batchesProcessed: 0,
    priorityBoosts: 0,
  };

  constructor(config?: Partial<QueueConfig>) {
    this.config = {
      maxQueueSize: 1000,
      maxConcurrentCommands: 5,
      batchSize: 3,
      batchTimeout: 2000, // 2 saniye
      retryDelay: 1000,
      priorityBoostThreshold: 30000, // 30 saniye
      performanceOptimization: true,
      ...config,
    };

    logger.info("Command Queue initialized", {
      config: this.config,
      queue_id: this.generateQueueId(),
    });

    this.startProcessing();
    this.startBatchProcessor();
  }

  private generateQueueId(): string {
    return `queue-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  }

  private generateCommandId(): string {
    return `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
  }

  /**
   * Kuyruğa komut ekle
   */
  public async addCommand(
    command: string,
    options: {
      priority?: CommandPriority;
      timeout?: number;
      maxAttempts?: number;
      metadata?: Record<string, any>;
      onSuccess?: (result: any) => void;
      onError?: (error: any) => void;
      onProgress?: (progress: any) => void;
    } = {},
  ): Promise<string> {
    // Queue boyut kontrolü
    if (this.queue.length >= this.config.maxQueueSize) {
      const error = "Queue is full, cannot add more commands";
      logger.warn(error, {
        queue_size: this.queue.length,
        max_size: this.config.maxQueueSize,
      });
      throw new Error(error);
    }

    const commandId = this.generateCommandId();
    const queuedCommand: QueuedCommand = {
      id: commandId,
      command,
      priority: options.priority || CommandPriority.NORMAL,
      addedAt: Date.now(),
      attempts: 0,
      maxAttempts: options.maxAttempts || 3,
      timeout: options.timeout || 30000,
      metadata: options.metadata,
      onSuccess: options.onSuccess,
      onError: options.onError,
      onProgress: options.onProgress,
    };

    // Öncelik sırasına göre ekle
    this.insertByPriority(queuedCommand);
    this.metrics.totalCommands++;

    logger.debug("Command added to queue", {
      command_id: commandId,
      command_preview:
        command.substring(0, 50) + (command.length > 50 ? "..." : ""),
      priority: queuedCommand.priority,
      queue_position: this.queue.findIndex((cmd) => cmd.id === commandId),
      queue_size: this.queue.length,
    });

    return commandId;
  }

  private insertByPriority(command: QueuedCommand): void {
    let insertIndex = this.queue.length;

    // Aynı veya daha düşük öncelikli ilk komutu bul
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority <= command.priority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, command);
  }

  /**
   * Priority boost - uzun süre bekleyen komutların önceliğini artır
   */
  private performPriorityBoost(): void {
    const now = Date.now();
    let boostedCount = 0;

    for (const command of this.queue) {
      const waitingTime = now - command.addedAt;

      if (
        waitingTime > this.config.priorityBoostThreshold &&
        command.priority < CommandPriority.CRITICAL
      ) {
        // Priority'yi bir seviye artır
        const oldPriority = command.priority;
        command.priority = Math.min(
          CommandPriority.CRITICAL,
          command.priority + 1,
        );

        if (command.priority !== oldPriority) {
          boostedCount++;
          this.metrics.priorityBoosts++;

          logger.debug("Command priority boosted", {
            command_id: command.id,
            old_priority: oldPriority,
            new_priority: command.priority,
            waiting_time_ms: waitingTime,
          });
        }
      }
    }

    if (boostedCount > 0) {
      // Priority değişen komutlar için queue'yu yeniden sırala
      this.reorderQueue();

      logger.info("Priority boost completed", {
        commands_boosted: boostedCount,
        total_boosts: this.metrics.priorityBoosts,
      });
    }
  }

  private reorderQueue(): void {
    this.queue.sort((a, b) => {
      // Önce priority'ye göre (yüksek önce)
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      // Aynı priority'de ekleme tarihine göre (eski önce)
      return a.addedAt - b.addedAt;
    });
  }

  /**
   * Batch oluşturucu
   */
  private createBatch(): CommandBatch | null {
    if (this.queue.length === 0) {
      return null;
    }

    // En yüksek öncelikli komutları al
    const batchCommands: QueuedCommand[] = [];
    const batchSize = Math.min(this.config.batchSize, this.queue.length);

    for (let i = 0; i < batchSize; i++) {
      if (this.queue.length > 0) {
        const command = this.queue.shift()!;
        batchCommands.push(command);
      }
    }

    if (batchCommands.length === 0) {
      return null;
    }

    // Batch'in priority'si en yüksek komutun priority'si
    const maxPriority = Math.max(...batchCommands.map((cmd) => cmd.priority));

    const batch: CommandBatch = {
      id: `batch-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      commands: batchCommands,
      priority: maxPriority,
      createdAt: Date.now(),
      status: "pending",
    };

    this.batches.set(batch.id, batch);

    logger.debug("Batch created", {
      batch_id: batch.id,
      command_count: batchCommands.length,
      max_priority: maxPriority,
      command_ids: batchCommands.map((cmd) => cmd.id),
    });

    return batch;
  }

  /**
   * Batch processor başlat
   */
  private startBatchProcessor(): void {
    this.batchInterval = setInterval(() => {
      this.performPriorityBoost();

      // Eğer işlenecek batch yoksa yeni batch oluştur
      const pendingBatches = Array.from(this.batches.values()).filter(
        (batch) => batch.status === "pending",
      ).length;

      if (pendingBatches === 0 && this.queue.length > 0) {
        this.createBatch();
      }
    }, this.config.batchTimeout);

    logger.debug("Batch processor started", {
      batch_timeout: this.config.batchTimeout,
    });
  }

  /**
   * Ana işleme döngüsü
   */
  private startProcessing(): void {
    this.processingInterval = setInterval(async () => {
      await this.processNextBatch();
    }, 500); // 500ms'de bir kontrol et

    logger.debug("Command processing started", {
      max_concurrent: this.config.maxConcurrentCommands,
      interval_ms: 500,
    });
  }

  private async processNextBatch(): Promise<void> {
    // Mevcut işlem sayısını kontrol et
    if (this.processingQueue.size >= this.config.maxConcurrentCommands) {
      return;
    }

    // İşlenecek batch bul (en yüksek öncelikli)
    const pendingBatches = Array.from(this.batches.values())
      .filter((batch) => batch.status === "pending")
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      });

    if (pendingBatches.length === 0) {
      return;
    }

    const batch = pendingBatches[0];
    await this.processBatch(batch);
  }

  private async processBatch(batch: CommandBatch): Promise<void> {
    batch.status = "processing";
    this.metrics.batchesProcessed++;

    logger.info("Processing batch", {
      batch_id: batch.id,
      command_count: batch.commands.length,
      priority: batch.priority,
    });

    const startTime = Date.now();

    // Paralel işleme için Promise.allSettled kullan
    const commandPromises = batch.commands.map(async (command) => {
      return this.executeQueuedCommand(command);
    });

    try {
      const results = await Promise.allSettled(commandPromises);

      // Sonuçları işle
      results.forEach((result, index) => {
        const command = batch.commands[index];

        if (result.status === "fulfilled") {
          this.handleCommandSuccess(command, result.value);
        } else {
          this.handleCommandError(command, result.reason);
        }
      });

      batch.status = "completed";

      const executionTime = Date.now() - startTime;
      this.updateAverageExecutionTime(executionTime);

      logger.info("Batch completed", {
        batch_id: batch.id,
        execution_time_ms: executionTime,
        successful_commands: results.filter((r) => r.status === "fulfilled")
          .length,
        failed_commands: results.filter((r) => r.status === "rejected").length,
      });
    } catch (error) {
      batch.status = "failed";

      logger.error("Batch processing failed", {
        batch_id: batch.id,
        error: error instanceof Error ? error.message : "Unknown error",
        command_count: batch.commands.length,
      });

      // Başarısız komutları yeniden kuyruğa ekle (retry logic)
      for (const command of batch.commands) {
        if (command.attempts < command.maxAttempts) {
          command.attempts++;
          setTimeout(() => {
            this.queue.unshift(command); // Öncelikli olarak başa ekle
          }, this.config.retryDelay);
        } else {
          this.handleCommandError(command, new Error("Max attempts reached"));
        }
      }
    }

    // Batch'i temizle (bellek optimizasyonu)
    setTimeout(() => {
      this.batches.delete(batch.id);
    }, 30000); // 30 saniye sonra temizle
  }

  private async executeQueuedCommand(command: QueuedCommand): Promise<any> {
    const commandId = command.id;
    this.processingQueue.add(commandId);

    const queueTime = Date.now() - command.addedAt;
    this.updateAverageQueueTime(queueTime);

    try {
      logger.debug("Executing queued command", {
        command_id: commandId,
        command: command.command,
        attempt: command.attempts + 1,
        queue_time_ms: queueTime,
      });

      // Progress callback
      if (command.onProgress) {
        command.onProgress({
          status: "executing",
          attempt: command.attempts + 1,
        });
      }

      // Komutu çalıştır
      const result = await executeCommand(command.command, commandId);

      this.processingQueue.delete(commandId);
      return result;
    } catch (error) {
      this.processingQueue.delete(commandId);
      throw error;
    }
  }

  private handleCommandSuccess(command: QueuedCommand, result: any): void {
    this.metrics.completedCommands++;

    logger.debug("Command completed successfully", {
      command_id: command.id,
      execution_time_ms: Date.now() - command.addedAt,
      exit_code: result.exit_code,
    });

    if (command.onSuccess) {
      try {
        command.onSuccess(result);
      } catch (error) {
        logger.warn("Command success callback error", {
          command_id: command.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  private handleCommandError(command: QueuedCommand, error: any): void {
    this.metrics.failedCommands++;

    logger.error("Command execution failed", {
      command_id: command.id,
      command: command.command,
      attempt: command.attempts,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    if (command.onError) {
      try {
        command.onError(error);
      } catch (callbackError) {
        logger.warn("Command error callback error", {
          command_id: command.id,
          error:
            callbackError instanceof Error
              ? callbackError.message
              : "Unknown error",
        });
      }
    }
  }

  private updateAverageExecutionTime(newTime: number): void {
    const completedCount = this.metrics.completedCommands;
    const currentAverage = this.metrics.averageExecutionTime;

    this.metrics.averageExecutionTime =
      (currentAverage * (completedCount - 1) + newTime) / completedCount;
  }

  private updateAverageQueueTime(newTime: number): void {
    const totalProcessed =
      this.metrics.completedCommands + this.metrics.failedCommands;
    const currentAverage = this.metrics.averageQueueTime;

    this.metrics.averageQueueTime =
      totalProcessed === 0
        ? newTime
        : (currentAverage * (totalProcessed - 1) + newTime) / totalProcessed;
  }

  /**
   * Kuyruktaki komut sayısı
   */
  public getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * İşlenmekte olan komut sayısı
   */
  public getProcessingCount(): number {
    return this.processingQueue.size;
  }

  /**
   * Komut iptal et
   */
  public cancelCommand(commandId: string): boolean {
    const commandIndex = this.queue.findIndex((cmd) => cmd.id === commandId);
    if (commandIndex !== -1) {
      const command = this.queue.splice(commandIndex, 1)[0];

      logger.debug("Command cancelled", {
        command_id: commandId,
        was_queued: true,
      });

      if (command.onError) {
        command.onError(new Error("Command cancelled"));
      }

      return true;
    }

    // Batch'lerde ara
    for (const batch of this.batches.values()) {
      const commandIndex = batch.commands.findIndex(
        (cmd) => cmd.id === commandId,
      );
      if (commandIndex !== -1 && batch.status === "pending") {
        const command = batch.commands.splice(commandIndex, 1)[0];

        logger.debug("Command cancelled from batch", {
          command_id: commandId,
          batch_id: batch.id,
        });

        if (command.onError) {
          command.onError(new Error("Command cancelled"));
        }

        return true;
      }
    }

    return false;
  }

  /**
   * Tüm kuyruğu temizle
   */
  public clearQueue(): void {
    const clearedCount = this.queue.length;
    this.queue = [];

    logger.info("Queue cleared", {
      commands_cleared: clearedCount,
    });
  }

  /**
   * Queue istatistikleri
   */
  public getStats() {
    const now = Date.now();
    const queueWaitTimes = this.queue.map((cmd) => now - cmd.addedAt);
    const averageWaitTime =
      queueWaitTimes.length > 0
        ? queueWaitTimes.reduce((sum, time) => sum + time, 0) /
          queueWaitTimes.length
        : 0;

    return {
      queue_size: this.queue.length,
      processing_count: this.processingQueue.size,
      batch_count: this.batches.size,
      metrics: this.metrics,
      performance: {
        average_queue_wait_time_ms: averageWaitTime,
        queue_utilization:
          (this.processingQueue.size / this.config.maxConcurrentCommands) * 100,
        throughput_per_minute:
          this.metrics.completedCommands > 0
            ? this.metrics.completedCommands / ((now - Date.now()) / 60000)
            : 0,
      },
      priority_distribution: this.getPriorityDistribution(),
    };
  }

  private getPriorityDistribution() {
    const distribution = {
      [CommandPriority.LOW]: 0,
      [CommandPriority.NORMAL]: 0,
      [CommandPriority.HIGH]: 0,
      [CommandPriority.CRITICAL]: 0,
    };

    for (const command of this.queue) {
      distribution[command.priority]++;
    }

    return distribution;
  }

  /**
   * Cleanup
   */
  public async cleanup(): Promise<void> {
    logger.info("Cleaning up command queue", {
      pending_commands: this.queue.length,
      processing_commands: this.processingQueue.size,
      pending_batches: this.batches.size,
    });

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }

    // Bekleyen komutları iptal et
    for (const command of this.queue) {
      if (command.onError) {
        command.onError(new Error("Queue shutdown"));
      }
    }

    this.queue = [];
    this.batches.clear();
    this.processingQueue.clear();

    logger.info("Command queue cleanup completed");
  }
}

// Singleton queue instance
export const commandQueue = new CommandQueueManager();

export default commandQueue;
