import { execa } from "execa";
import * as fs from "fs";
import * as path from "path";
import { TOKEN, SERVER_URL, VPS_ID } from "../config";

// Komut çalıştırma betiğinin yolu
const COMMAND_SCRIPT =
  process.env.COMMAND_SCRIPT || "/opt/pingushell/run-command.sh";

/**
 * Sistem komutu çalıştırma fonksiyonu
 */
export const executeCommand = async (
  command: string,
): Promise<{
  success: boolean;
  output: string;
  error?: string;
  exit_code?: number;
}> => {
  try {
    // Komut ID oluştur
    const commandId = Date.now().toString() + Math.floor(Math.random() * 1000);

    // Komut çalıştırma betiği var mı kontrol et
    if (fs.existsSync(COMMAND_SCRIPT)) {
      console.log(`Komut betiği kullanılıyor: ${COMMAND_SCRIPT}`);

      // Komutu betik üzerinden çalıştır
      // Betik kendisi sonuçları API'ye göndereceği için burada sadece çalıştırıp sonucu döndürüyoruz
      const { stdout, stderr, exitCode } = await execa(COMMAND_SCRIPT, [
        commandId,
        command,
        TOKEN,
        SERVER_URL,
      ]);

      return {
        success: exitCode === 0,
        output: stdout,
        error: stderr || undefined,
        exit_code: exitCode,
      };
    } else {
      console.warn(
        `Komut betiği bulunamadı (${COMMAND_SCRIPT}), direkt komut çalıştırılıyor.`,
      );

      // Betiği kullanmadan direkt komutu çalıştır
      const { stdout, stderr, exitCode } = await execa(command, {
        shell: true,
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
 * Sistem bilgilerini toplayan fonksiyonlar
 */
export const getSystemInfo = async (): Promise<{
  hostname: string;
  os: string;
  cpuCores: number;
  ramTotal: string;
  diskSpace: string;
}> => {
  try {
    // Hostname
    const { stdout: hostname } = await execa("hostname", { shell: true });

    // İşletim sistemi bilgisi
    const { stdout: osInfo } = await execa(
      "cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2",
      { shell: true },
    );

    // CPU çekirdek sayısı
    const { stdout: cpuCores } = await execa("nproc", { shell: true });

    // RAM miktarı
    const { stdout: ramInfo } = await execa(
      "free -h | grep Mem | awk '{print $2}'",
      { shell: true },
    );

    // Disk alanı
    const { stdout: diskInfo } = await execa(
      "df -h / | grep / | awk '{print $2}'",
      { shell: true },
    );

    return {
      hostname: hostname.trim(),
      os: osInfo.trim().replace(/"/g, ""),
      cpuCores: parseInt(cpuCores.trim()) || 0,
      ramTotal: ramInfo.trim(),
      diskSpace: diskInfo.trim(),
    };
  } catch (error) {
    console.error("Sistem bilgisi alma hatası:", error);

    // Bir hata olursa varsayılan değerleri döndür
    return {
      hostname: "unknown",
      os: "unknown",
      cpuCores: 0,
      ramTotal: "unknown",
      diskSpace: "unknown",
    };
  }
};
