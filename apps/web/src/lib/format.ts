export function formatDuration(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "--:--";
  }
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatTimestampMs(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  return formatDuration(clamped);
}

export function formatOffsetMs(offsetMs: number): string {
  if (offsetMs === 0) {
    return "0 ms";
  }
  const sign = offsetMs > 0 ? "+" : "−";
  return `${sign}${Math.abs(offsetMs)} ms`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIdx]}`;
}

export const LANGUAGE_LABELS: Record<string, string> = {
  zh: "中文 (Chino)",
  es: "Español",
  en: "English",
  ja: "日本語 (Japonés)",
  ko: "한국어 (Coreano)",
  und: "Otro / Sin definir",
};

export function formatLanguageLabel(lang: string): string {
  return LANGUAGE_LABELS[lang] ?? lang.toUpperCase();
}
