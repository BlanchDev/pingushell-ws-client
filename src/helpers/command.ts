import { execa } from "execa";
import os from "os";

// Komut çalıştırma script'i için ortam değişkeni
const COMMAND_SCRIPT = process.env.COMMAND_SCRIPT || "";
const SERVER_URL = process.env.SERVER_URL || "";
const CONNECTION_TOKEN = process.env.CONNECTION_TOKEN || "";

/**
 * Sistem komutu çalıştırma fonksiyonu
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
  try {
    console.log(
      `Komut çalıştırılıyor: ${command} ${
        command_id ? `(ID: ${command_id})` : ""
      }`,
    );

    // Eğer komut betiği tanımlıysa onu kullan
    if (COMMAND_SCRIPT && command_id) {
      console.log(`COMMAND_SCRIPT kullanılıyor: ${COMMAND_SCRIPT}`);

      // Komut betiğini çalıştır (PinguShell kurulum betiği tarafından oluşturulan betik)
      const { stdout, stderr, exitCode } = await execa(COMMAND_SCRIPT, [
        command_id,
        command,
        CONNECTION_TOKEN,
        SERVER_URL,
      ]);

      return {
        success: exitCode === 0,
        output: stdout,
        error: stderr || undefined,
        exit_code: exitCode,
      };
    } else {
      // Komut betiği yoksa direkt çalıştır
      const { stdout, stderr, exitCode } = await execa(command, {
        shell: true,
        timeout: 60000, // 60 saniye zaman aşımı
      });

      return {
        success: exitCode === 0,
        output: stdout,
        error: stderr || undefined,
        exit_code: exitCode,
      };
    }
  } catch (error: any) {
    console.error("Komut çalıştırma hatası:", error);

    return {
      success: false,
      output: error?.stdout || "",
      error: error?.stderr || error?.message || "Bilinmeyen hata",
      exit_code: error?.exitCode || 1,
    };
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
        // Linux dağıtım bilgisini almaya çalış
        const { stdout: distro } = await execa("cat /etc/issue", {
          shell: true,
        });
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
