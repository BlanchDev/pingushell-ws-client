import { execa } from "execa";
import os from "os";
import path from "path";

// Bu sabitler gerekli olmayacak
// const COMMAND_SCRIPT = process.env.COMMAND_SCRIPT || "";
// const SERVER_URL = process.env.SERVER_URL || "";
// const CONNECTION_TOKEN = process.env.CONNECTION_TOKEN || "";

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

    // Dosya yazma işlemi için gerekli dizin kontrolü
    const dirRegex = /> (["']?)(\/[^'">\s]+)\/([^'">\s]+)(["']?)/;
    const dirMatch = command.match(dirRegex);

    // Eğer dosya yoluna yazma işlemi varsa ve bu bir mutlak yol ise
    if (dirMatch && dirMatch[2]) {
      const dirPath = dirMatch[2];
      console.log(`Dosya yoluna yazma işlemi tespit edildi: ${dirPath}`);

      try {
        // Dizinin varlığını kontrol et ve oluştur
        await execa(`mkdir -p ${dirPath}`, {
          shell: true,
          reject: false, // Hata oluşsa bile devam et
        });
        console.log(`Dizin oluşturuldu/kontrol edildi: ${dirPath}`);
      } catch (e) {
        console.log(`Dizin oluşturma hatası (devam edilecek): ${e}`);
      }
    }

    // Komut çalıştırma
    const { stdout, stderr, exitCode } = await execa(command, {
      shell: true,
      timeout: 60000, // 60 saniye zaman aşımı
      cwd: process.cwd(), // Çalışma dizinini belirt
      env: {
        ...process.env,
        HOME: os.homedir(), // HOME değişkenini doğru ayarla
      },
    });

    // Başarı durumuna göre sonucu döndür
    return {
      success: exitCode === 0,
      output: stdout,
      error: stderr || undefined,
      exit_code: exitCode,
    };
  } catch (error: any) {
    console.error("Komut çalıştırma hatası:", error);

    // Hata mesajını daha anlaşılır şekilde döndür
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
