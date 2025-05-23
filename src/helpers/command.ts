import os from "os";
import path from "path";
import { logger } from "../services/logger";

// Güvenlik konfigürasyonu
interface CommandSecurityConfig {
  allowedCommands: string[];
  maxOutputLength: number;
  timeout: number;
  allowedPaths: string[];
}

// Güvenlik yapılandırması - şu an sadece echo komutlarına izin ver
const SECURITY_CONFIG: CommandSecurityConfig = {
  allowedCommands: [
    "echo", // Temel echo komutu
  ],
  maxOutputLength: 10_000, // Maksimum çıktı uzunluğu (10KB)
  timeout: 30_000, // 30 saniye timeout
  allowedPaths: [
    "/tmp", // Geçici dosyalar için
    "/var/log", // Log dosyaları için (okuma)
  ],
};

// Komut validation sonucu
interface ValidationResult {
  isValid: boolean;
  error?: string;
  sanitizedCommand?: string;
}

/**
 * Komutu güvenlik kontrolünden geçir
 */
const validateCommand = (command: string): ValidationResult => {
  try {
    // Boş komut kontrolü
    if (!command || command.trim().length === 0) {
      return { isValid: false, error: "Boş komut gönderildi" };
    }

    // Komut uzunluğu kontrolü
    if (command.length > 1000) {
      return {
        isValid: false,
        error: "Komut çok uzun (maksimum 1000 karakter)",
      };
    }

    // Sanitize: Tehlikeli karakterleri temizle
    const sanitized = command.trim();

    // Tehlikeli operatörleri kontrol et
    const dangerousPatterns = [
      /[;&|`$(){}[\]]/g, // Shell operatörleri
      /\.\./g, // Directory traversal
      /\/\/+/g, // Çoklu slash
      /\s+&&\s+/g, // AND operatörü
      /\s+\|\|\s+/g, // OR operatörü
      />\s*\/dev\/null/g, // Output redirection
      /2>&1/g, // Error redirection
      /\$\(/g, // Command substitution
      /`/g, // Backtick execution
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(sanitized)) {
        return {
          isValid: false,
          error: `Güvenlik riski: Yasak karakter/operatör tespit edildi`,
        };
      }
    }

    // Komutu parçala ve ana komutu bul
    const parts = sanitized.split(/\s+/);
    const baseCommand = parts[0]?.toLowerCase();

    if (!baseCommand) {
      return { isValid: false, error: "Komut adı bulunamadı" };
    }

    // Whitelist kontrolü
    if (!SECURITY_CONFIG.allowedCommands.includes(baseCommand)) {
      return {
        isValid: false,
        error: `Komut '${baseCommand}' whitelist'te yok. İzin verilen komutlar: ${SECURITY_CONFIG.allowedCommands.join(
          ", ",
        )}`,
      };
    }

    // Echo komutu için özel validasyon
    if (baseCommand === "echo") {
      return validateEchoCommand(sanitized);
    }

    return { isValid: true, sanitizedCommand: sanitized };
  } catch (error) {
    return {
      isValid: false,
      error: `Komut validation hatası: ${error}`,
    };
  }
};

/**
 * Echo komutu için özel güvenlik kontrolü
 */
const validateEchoCommand = (command: string): ValidationResult => {
  try {
    // Echo parametrelerini kontrol et
    const parts = command.split(/\s+/);

    // Echo bayraklarını kontrol et (sadece güvenli olanlar)
    const allowedFlags = ["-n", "-e", "-E"];
    const flags = parts.slice(1).filter((part) => part.startsWith("-"));

    for (const flag of flags) {
      if (!allowedFlags.includes(flag)) {
        return {
          isValid: false,
          error: `Echo komutu için geçersiz bayrak: ${flag}. İzin verilenler: ${allowedFlags.join(
            ", ",
          )}`,
        };
      }
    }

    // Output redirection kontrolü
    if (command.includes(">") || command.includes(">>")) {
      return {
        isValid: false,
        error: "Echo komutu ile dosya yazma işlemi şu an yasak",
      };
    }

    return { isValid: true, sanitizedCommand: command };
  } catch (error) {
    return {
      isValid: false,
      error: `Echo validation hatası: ${error}`,
    };
  }
};

/**
 * Güvenli sistem komutu çalıştırma fonksiyonu - Whitelist tabanlı
 */
export const executeCommand = async (
  command: string,
  command_id: string = "",
): Promise<{
  success: boolean;
  output: string;
  error?: string;
  exit_code?: number;
}> => {
  const startTime = Date.now();

  try {
    // Komut başlangıç audit logu
    logger.commandExecution(command_id, command, "start", {
      original_command: command,
      timestamp: new Date().toISOString(),
    });

    logger.debug("Security validation started", {
      command_id,
      command_length: command.length,
      command_preview:
        command.substring(0, 50) + (command.length > 50 ? "..." : ""),
    });

    // Komut güvenlik kontrolü
    const validation = validateCommand(command);
    if (!validation.isValid) {
      // Güvenlik ihlali kaydı
      logger.securityViolation("Command validation failed", command, {
        command_id,
        validation_error: validation.error,
        blocked_at: new Date().toISOString(),
      });

      logger.commandExecution(command_id, command, "blocked", {
        reason: validation.error,
        execution_time_ms: Date.now() - startTime,
      });

      return {
        success: false,
        output: "",
        error: `Güvenlik hatası: ${validation.error}`,
        exit_code: 403, // Forbidden
      };
    }

    const sanitizedCommand = validation.sanitizedCommand!;
    logger.info("Security validation passed", {
      command_id,
      original_command: command,
      sanitized_command: sanitizedCommand,
      validation_time_ms: Date.now() - startTime,
    });

    // Timeout ile komut çalıştırma
    const proc = Bun.spawn(["bash", "-c", sanitizedCommand], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: os.homedir(),
        // Güvenlik için çevresel değişkenleri kısıtla
        PATH: "/usr/local/bin:/usr/bin:/bin", // Sadece standart PATH
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    // Timeout kontrolü
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill();
        reject(
          new Error(
            `Komut zaman aşımına uğradı (${SECURITY_CONFIG.timeout}ms)`,
          ),
        );
      }, SECURITY_CONFIG.timeout);
    });

    // Yarış durumu: ya komut biter ya timeout olur
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]);

    // Çıktı uzunluğu kontrolü
    if (stdout.length > SECURITY_CONFIG.maxOutputLength) {
      logger.warn("Command output too large", {
        command_id,
        output_length: stdout.length,
        max_allowed: SECURITY_CONFIG.maxOutputLength,
        truncated: true,
      });

      return {
        success: false,
        output: stdout.substring(0, 500) + "\n... (çıktı çok uzun, kısaltıldı)",
        error: `Çıktı maksimum uzunluğu aştı (${SECURITY_CONFIG.maxOutputLength} karakter)`,
        exit_code: 413, // Payload Too Large
      };
    }

    const executionTime = Date.now() - startTime;

    // Performance metric
    logger.performanceMetric("command_execution_time", executionTime, "ms", {
      command_id,
      exit_code: exitCode,
      output_length: stdout.length,
      error_length: stderr?.length || 0,
    });

    // Komut tamamlanma logu
    if (exitCode === 0) {
      logger.commandExecution(command_id, command, "success", {
        execution_time_ms: executionTime,
        output_length: stdout.length,
        stderr_length: stderr?.length || 0,
      });
    } else {
      logger.commandExecution(command_id, command, "failed", {
        execution_time_ms: executionTime,
        exit_code: exitCode,
        output_length: stdout.length,
        stderr_length: stderr?.length || 0,
        error_output: stderr,
      });
    }

    return {
      success: exitCode === 0,
      output: stdout,
      error: stderr || undefined,
      exit_code: exitCode,
    };
  } catch (error: any) {
    const executionTime = Date.now() - startTime;

    logger.error("Command execution error", {
      command_id,
      command,
      error: error?.message || "Unknown error",
      execution_time_ms: executionTime,
      stack_trace: error?.stack,
    });

    logger.commandExecution(command_id, command, "failed", {
      execution_time_ms: executionTime,
      error: error?.message || "Unknown error",
      error_type: "system_error",
    });

    return {
      success: false,
      output: "",
      error: error?.message || "Bilinmeyen hata",
      exit_code: 500, // Internal Server Error
    };
  }
};

/**
 * Güvenlik konfigürasyonunu döndür (debugging için)
 */
export const getSecurityConfig = (): CommandSecurityConfig => {
  return { ...SECURITY_CONFIG };
};

/**
 * Yeni komut whitelist'e ekle (geliştirme aşamasında kullanılacak)
 */
export const addToWhitelist = (command: string): boolean => {
  try {
    if (!SECURITY_CONFIG.allowedCommands.includes(command)) {
      SECURITY_CONFIG.allowedCommands.push(command);
      console.log(`✅ Komut whitelist'e eklendi: ${command}`);
      return true;
    }
    console.log(`⚠️ Komut zaten whitelist'te: ${command}`);
    return false;
  } catch (error) {
    console.error(`❌ Whitelist ekleme hatası: ${error}`);
    return false;
  }
};

/**
 * Sistem bilgilerini toplar
 */
export const getSystemInfo = async (): Promise<{
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  cpus: string;
  memory: string;
  uptime: string;
  [key: string]: string;
}> => {
  try {
    // İşletim sistemi bilgilerini al
    const hostname = os.hostname();
    const platform = os.platform();
    const release = os.release();
    const arch = os.arch();
    const cpus = `${os.cpus().length} x ${os.cpus()[0]?.model || "Unknown"}`;
    const totalMemory = Math.round(os.totalmem() / (1024 * 1024 * 1024)); // GB cinsinden
    const memory = `${totalMemory} GB`;
    const uptime = `${Math.floor(os.uptime() / 3600)} hours`;

    // Ek bilgiler toplamaya çalış
    let additional: Record<string, string> = {};

    if (platform === "linux") {
      try {
        // Linux dağıtım bilgisini almaya çalış - Bun.spawn ile
        const proc = Bun.spawn(["cat", "/etc/issue"]);
        const distro = await new Response(proc.stdout).text();
        additional.distro = distro.split("\\n")[0].trim();
      } catch (e) {
        additional.distro = "Unknown Linux";
      }
    }

    return {
      hostname,
      platform,
      release,
      arch,
      cpus,
      memory,
      uptime,
      ...additional,
    };
  } catch (error) {
    console.error("Sistem bilgisi toplama hatası:", error);
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: "Unknown",
      memory: "Unknown",
      uptime: "Unknown",
    };
  }
};
