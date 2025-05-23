import fs from "fs";
import path from "path";
import { VPS_ID } from "../config";

// Log seviyeleri
export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
  SECURITY = "security",
  AUDIT = "audit",
}

// Log entry interface
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
  vps_id?: string;
  source: string;
  session_id?: string;
  client_id?: string;
  command_id?: string;
  security_context?: {
    ip?: string;
    user_agent?: string;
    connection_type?: string;
  };
}

// Logger konfigürasyonu
interface LoggerConfig {
  logToConsole: boolean;
  logToFile: boolean;
  logDirectory: string;
  maxFileSize: number; // MB cinsinden
  maxFiles: number;
  minLevel: LogLevel;
}

class Logger {
  private config: LoggerConfig;
  private sessionId: string;

  constructor(config?: Partial<LoggerConfig>) {
    this.config = {
      logToConsole: true,
      logToFile: true,
      logDirectory: "./logs",
      maxFileSize: 10, // 10MB
      maxFiles: 5,
      minLevel: LogLevel.INFO,
      ...config,
    };

    this.sessionId = this.generateSessionId();

    // Log dizinini oluştur
    if (this.config.logToFile) {
      this.ensureLogDirectory();
    }

    // Başlangıç logu
    this.info("Logger initialized", {
      config: this.config,
      session_id: this.sessionId,
    });
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private ensureLogDirectory(): void {
    try {
      if (!fs.existsSync(this.config.logDirectory)) {
        fs.mkdirSync(this.config.logDirectory, { recursive: true });
      }
    } catch (error) {
      console.error("Log dizini oluşturulamadı:", error);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [
      LogLevel.DEBUG,
      LogLevel.INFO,
      LogLevel.WARN,
      LogLevel.ERROR,
      LogLevel.SECURITY,
      LogLevel.AUDIT,
    ];
    const currentIndex = levels.indexOf(level);
    const minIndex = levels.indexOf(this.config.minLevel);
    return currentIndex >= minIndex;
  }

  private formatLogEntry(
    level: LogLevel,
    message: string,
    data?: any,
    extra?: Partial<LogEntry>,
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      vps_id: VPS_ID || "unknown",
      source: "ws-client",
      session_id: this.sessionId,
      ...extra,
    };
  }

  private writeToConsole(entry: LogEntry): void {
    const emoji = this.getLevelEmoji(entry.level);
    const colorCode = this.getLevelColor(entry.level);

    console.log(
      `${colorCode}${emoji} [${
        entry.timestamp
      }] [${entry.level.toUpperCase()}] [${entry.vps_id}] ${
        entry.message
      }\x1b[0m`,
    );

    if (entry.data) {
      console.log(
        `${colorCode}   Data:`,
        JSON.stringify(entry.data, null, 2),
        "\x1b[0m",
      );
    }
  }

  private getLevelEmoji(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG:
        return "🔍";
      case LogLevel.INFO:
        return "ℹ️";
      case LogLevel.WARN:
        return "⚠️";
      case LogLevel.ERROR:
        return "❌";
      case LogLevel.SECURITY:
        return "🚨";
      case LogLevel.AUDIT:
        return "📋";
      default:
        return "📝";
    }
  }

  private getLevelColor(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG:
        return "\x1b[36m"; // Cyan
      case LogLevel.INFO:
        return "\x1b[32m"; // Green
      case LogLevel.WARN:
        return "\x1b[33m"; // Yellow
      case LogLevel.ERROR:
        return "\x1b[31m"; // Red
      case LogLevel.SECURITY:
        return "\x1b[35m"; // Magenta
      case LogLevel.AUDIT:
        return "\x1b[34m"; // Blue
      default:
        return "\x1b[37m"; // White
    }
  }

  private async writeToFile(entry: LogEntry): Promise<void> {
    try {
      const logFileName = this.getLogFileName(entry.level);
      const logFilePath = path.join(this.config.logDirectory, logFileName);
      const logLine = JSON.stringify(entry) + "\n";

      // Dosya boyutu kontrolü
      if (fs.existsSync(logFilePath)) {
        const stats = fs.statSync(logFilePath);
        if (stats.size / (1024 * 1024) > this.config.maxFileSize) {
          await this.rotateLogFile(logFilePath);
        }
      }

      fs.appendFileSync(logFilePath, logLine);
    } catch (error) {
      console.error("Log dosyasına yazma hatası:", error);
    }
  }

  private getLogFileName(level: LogLevel): string {
    const date = new Date().toISOString().split("T")[0];
    const vpsId = VPS_ID || "unknown";

    if (level === LogLevel.SECURITY || level === LogLevel.AUDIT) {
      return `security-${vpsId}-${date}.log`;
    }

    return `app-${vpsId}-${date}.log`;
  }

  private async rotateLogFile(filePath: string): Promise<void> {
    try {
      const dir = path.dirname(filePath);
      const ext = path.extname(filePath);
      const basename = path.basename(filePath, ext);

      // Mevcut rotate edilmiş dosyaları bul
      for (let i = this.config.maxFiles - 1; i >= 1; i--) {
        const oldFile = path.join(dir, `${basename}.${i}${ext}`);
        const newFile = path.join(dir, `${basename}.${i + 1}${ext}`);

        if (fs.existsSync(oldFile)) {
          if (i === this.config.maxFiles - 1) {
            fs.unlinkSync(oldFile); // En eski dosyayı sil
          } else {
            fs.renameSync(oldFile, newFile);
          }
        }
      }

      // Mevcut dosyayı .1 olarak yeniden adlandır
      const rotatedFile = path.join(dir, `${basename}.1${ext}`);
      fs.renameSync(filePath, rotatedFile);
    } catch (error) {
      console.error("Log rotation hatası:", error);
    }
  }

  private async log(
    level: LogLevel,
    message: string,
    data?: any,
    extra?: Partial<LogEntry>,
  ): Promise<void> {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry = this.formatLogEntry(level, message, data, extra);

    if (this.config.logToConsole) {
      this.writeToConsole(entry);
    }

    if (this.config.logToFile) {
      await this.writeToFile(entry);
    }
  }

  // Public log methods
  debug(message: string, data?: any, extra?: Partial<LogEntry>): void {
    this.log(LogLevel.DEBUG, message, data, extra);
  }

  info(message: string, data?: any, extra?: Partial<LogEntry>): void {
    this.log(LogLevel.INFO, message, data, extra);
  }

  warn(message: string, data?: any, extra?: Partial<LogEntry>): void {
    this.log(LogLevel.WARN, message, data, extra);
  }

  error(message: string, data?: any, extra?: Partial<LogEntry>): void {
    this.log(LogLevel.ERROR, message, data, extra);
  }

  security(message: string, data?: any, extra?: Partial<LogEntry>): void {
    this.log(LogLevel.SECURITY, message, data, extra);
  }

  audit(message: string, data?: any, extra?: Partial<LogEntry>): void {
    this.log(LogLevel.AUDIT, message, data, extra);
  }

  // Özel güvenlik logging methodları
  securityViolation(
    violation: string,
    commandAttempt: string,
    details?: any,
  ): void {
    this.security(`Security Violation: ${violation}`, {
      violation_type: violation,
      command_attempt: commandAttempt,
      details,
      severity: "high",
    });
  }

  commandExecution(
    commandId: string,
    command: string,
    status: "start" | "success" | "failed" | "blocked",
    details?: any,
  ): void {
    const level = status === "blocked" ? LogLevel.SECURITY : LogLevel.AUDIT;
    this.log(
      level,
      `Command ${status}`,
      {
        command_id: commandId,
        command,
        status,
        details,
      },
      { command_id: commandId },
    );
  }

  connectionEvent(
    event: "connect" | "disconnect" | "auth_success" | "auth_failed",
    details?: any,
  ): void {
    this.audit(`WebSocket ${event}`, {
      event,
      details,
      session_id: this.sessionId,
    });
  }

  performanceMetric(
    metric: string,
    value: number,
    unit: string,
    details?: any,
  ): void {
    this.info(`Performance Metric: ${metric}`, {
      metric,
      value,
      unit,
      details,
    });
  }

  // Sistem durumu logging
  systemHealth(
    component: string,
    status: "healthy" | "degraded" | "unhealthy",
    metrics?: any,
  ): void {
    const level = status === "healthy" ? LogLevel.INFO : LogLevel.WARN;
    this.log(level, `System Health: ${component} is ${status}`, {
      component,
      status,
      metrics,
    });
  }
}

// Singleton logger instance
export const logger = new Logger({
  logToConsole: true,
  logToFile: true,
  logDirectory: "./logs",
  maxFileSize: 10,
  maxFiles: 5,
  minLevel:
    process.env.NODE_ENV === "production" ? LogLevel.INFO : LogLevel.DEBUG,
});

export default logger;
