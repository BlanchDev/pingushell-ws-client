import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PerformanceIntegrationManager } from "../services/performanceIntegration";

describe("PerformanceIntegrationManager", () => {
  let performanceManager: PerformanceIntegrationManager;

  beforeEach(() => {
    performanceManager = new PerformanceIntegrationManager({
      enableConnectionPooling: true,
      enableCommandQueuing: true,
      enableMemoryOptimization: true,
      enableResultCaching: true,
      enableMetricsCollection: true,
      autoOptimization: false, // Disable for testing
    });
  });

  afterEach(async () => {
    await performanceManager.cleanup();
  });

  it("should initialize with default configuration", () => {
    const manager = new PerformanceIntegrationManager();
    const stats = manager.getStats();

    expect(stats).toHaveProperty("connectionPoolStats");
    expect(stats).toHaveProperty("commandQueueStats");
    expect(stats).toHaveProperty("memoryStats");
    expect(stats).toHaveProperty("systemHealth");
  });

  it("should provide performance statistics", () => {
    const stats = performanceManager.getStats();

    expect(stats).toHaveProperty("averageCommandTime");
    expect(stats).toHaveProperty("totalCommands");
    expect(stats).toHaveProperty("cacheHitRate");
    expect(stats).toHaveProperty("systemHealth");

    expect(typeof stats.averageCommandTime).toBe("number");
    expect(typeof stats.totalCommands).toBe("number");
    expect(typeof stats.cacheHitRate).toBe("number");
    expect(["excellent", "good", "fair", "poor"]).toContain(stats.systemHealth);
  });

  it("should trigger manual optimization", async () => {
    // Should not throw error
    await expect(
      performanceManager.triggerOptimization(),
    ).resolves.toBeUndefined();
  });

  it("should cleanup resources properly", async () => {
    await expect(performanceManager.cleanup()).resolves.toBeUndefined();
  });
});
