export const INDONESIA_BBOX = {
  west: 94.0,
  south: -12.0,
  east: 142.0,
  north: 7.0,
  asCsv(): string {
    return `${this.west},${this.south},${this.east},${this.north}`;
  }
};

export const NASA_FIRMS_CONFIG = {
  baseUrl: "https://firms.modaps.eosdis.nasa.gov/api/area/csv",
  product: "VIIRS_NOAA20_NRT",
  sources: ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT", "VIIRS_SNPP_NRT"],
  dayRange: 2,
  scheduleMinutes: 60,
  timeoutMs: 25000,
  maxRetries: 2,
  thresholds24h: {
    none: 0,
    lowMax: 5,
    mediumMax: 20,
    highMax: 50
  }
};

export const OPENAQ_V3_CONFIG = {
  baseUrl: "https://api.openaq.org/v3",
  pm25ParameterId: 2,
  pm25ParameterName: "pm25",
  allowedUnits: new Set(["µg/m³", "ug/m3"]),
  scheduleMinutes: 60,
  windowHours: 24,
  minHourlyCompleteness: 18,
  maxStationStalenessHours: 6,
  pageLimit: 1000,
  timeoutMs: 25000,
  maxRetries: 3,
  ispuThresholds24h: {
    baikMax: 15.5,
    sedangMax: 55.4,
    tidakSehatMax: 150.4,
    sangatTidakSehatMax: 250.4
  }
};

export const COMMUNITY_PERCEPTION_CONFIG = {
  minPct: 0,
  maxPct: 100,
  stepPct: 10,
  minDurationDays: 1,
  maxDurationDays: 35
};

export function isInsideIndonesiaBbox(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= INDONESIA_BBOX.south &&
    lat <= INDONESIA_BBOX.north &&
    lon >= INDONESIA_BBOX.west &&
    lon <= INDONESIA_BBOX.east
  );
}

export function classifyHotspot24h(count: number | null, status = "ok"): string {
  if (status === "no_data" || count === null || !Number.isFinite(count)) return "Belum tersedia";
  if (status === "error") return "Gagal diperbarui";
  if (count <= NASA_FIRMS_CONFIG.thresholds24h.none) return "Tidak ada deteksi";
  if (count <= NASA_FIRMS_CONFIG.thresholds24h.lowMax) return "Rendah";
  if (count <= NASA_FIRMS_CONFIG.thresholds24h.mediumMax) return "Sedang";
  if (count <= NASA_FIRMS_CONFIG.thresholds24h.highMax) return "Tinggi";
  return "Sangat tinggi";
}

export function classifyIspuPm25(ugm3: number | null, status = "ok"): string {
  if (status === "no_data") return "No Data";
  if (status === "insufficient_data") return "Data tidak mencukupi";
  if (ugm3 === null || !Number.isFinite(ugm3)) return "No Data";
  if (ugm3 <= OPENAQ_V3_CONFIG.ispuThresholds24h.baikMax) return "Baik";
  if (ugm3 <= OPENAQ_V3_CONFIG.ispuThresholds24h.sedangMax) return "Sedang";
  if (ugm3 <= OPENAQ_V3_CONFIG.ispuThresholds24h.tidakSehatMax) return "Tidak sehat";
  if (ugm3 <= OPENAQ_V3_CONFIG.ispuThresholds24h.sangatTidakSehatMax) return "Sangat tidak sehat";
  return "Berbahaya";
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 2,
  timeoutMs = 25000
): Promise<Response> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfterHeader = response.headers.get("Retry-After") || response.headers.get("x-ratelimit-reset");
        const waitSec = retryAfterHeader ? Math.min(Math.max(Number(retryAfterHeader) || 5, 2), 60) : Math.pow(2, attempt + 1);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        attempt++;
        continue;
      }

      if (response.status >= 500 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
        attempt++;
        continue;
      }

      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= maxRetries) break;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
      attempt++;
    }
  }

  throw lastError || new Error("Request timeout or network failure");
}
