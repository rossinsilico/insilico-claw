import type {
  AppleHealthAccessResult,
  AppleHealthMetric,
  AppleHealthSummary,
  AppleHealthWriteResult,
  R1HealthSampleRecord,
  ToolCallSignal,
} from "./apple-health-types";

export type { AppleHealthSummary, R1HealthSampleRecord } from "./apple-health-types";

declare const FaceclawHealthKit: any;

const REQUEST_TIMEOUT_MS = 9_000;
let nextRequestId = 1;

export function isAppleHealthAvailable(): boolean {
  return Boolean(FaceclawHealthKit.shared().isAvailable());
}

export function requestAppleHealthAccess(): Promise<AppleHealthAccessResult> {
  return new Promise((resolve, reject) => {
    FaceclawHealthKit.shared().requestAccessWithCompletion((json: string | null, error: string | null) => {
      try {
        if (error) throw new Error(error);
        const value = parseObject(json);
        if (value.ok !== true || value.requestCompleted !== true ||
            value.readAuthorization !== "not_disclosed_by_healthkit") throw new Error("Invalid Apple Health access response");
        resolve(value as AppleHealthAccessResult);
      } catch (cause) { reject(asError(cause)); }
    });
  });
}

export function readAppleHealthSummary(
  day: "today" | "yesterday",
  signal?: ToolCallSignal,
): Promise<AppleHealthSummary> {
  if (day !== "today" && day !== "yesterday") return Promise.reject(new Error("Invalid Apple Health day"));
  return nativeRequest(signal, (requestId, callback) => {
    FaceclawHealthKit.shared().querySummaryRequestIdCompletion(day, requestId, callback);
  }, value => validateSummary(value, day));
}

export function writeR1HealthSamples(
  records: readonly R1HealthSampleRecord[],
  signal?: ToolCallSignal,
): Promise<AppleHealthWriteResult> {
  if (!validRecords(records)) return Promise.reject(new Error("Invalid R1 health samples"));
  return nativeRequest(signal, (requestId, callback) => {
    FaceclawHealthKit.shared().writeRingSamplesRequestIdCompletion(JSON.stringify(records), requestId, callback);
  }, (value, requestId) => {
    if (value.ok !== true || value.saveCompleted !== true || value.requestId !== requestId ||
        !Number.isInteger(value.submittedCount) || value.submittedCount !== records.length) {
      throw new Error("Invalid Apple Health write response");
    }
    return value as AppleHealthWriteResult;
  });
}

function nativeRequest<T>(
  signal: ToolCallSignal | undefined,
  start: (requestId: string, callback: (json: string | null, error: string | null) => void) => void,
  validate: (value: Record<string, unknown>, requestId: string) => T,
): Promise<T> {
  const requestId = `health-${Date.now()}-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const cancel = (message: string) => finish(() => {
      FaceclawHealthKit.shared().cancelRequest(requestId);
      reject(new Error(message));
    });
    const abort = () => cancel("Apple Health request cancelled");
    const timer = setTimeout(() => cancel("Apple Health request timed out"), REQUEST_TIMEOUT_MS);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      start(requestId, (json, error) => finish(() => {
        try {
          if (error) throw new Error(error);
          const value = parseObject(json);
          if (value.ok === false) throw new Error(nativeError(value) || "Apple Health request failed");
          resolve(validate(value, requestId));
        } catch (cause) { reject(asError(cause)); }
      }));
    } catch (cause) { finish(() => reject(asError(cause))); }
  });
}

function parseObject(json: string | null): Record<string, unknown> {
  if (typeof json !== "string" || !json.trim()) throw new Error("Invalid Apple Health response");
  const value: unknown = JSON.parse(json);
  if (!isObject(value)) throw new Error("Invalid Apple Health response");
  return value;
}

function validateSummary(value: Record<string, unknown>, day: "today" | "yesterday"): AppleHealthSummary {
  const interval = value.interval;
  const metrics = value.metrics;
  if (value.ok !== true || value.source !== "apple-health" || value.day !== day ||
      typeof value.timeZone !== "string" || !value.timeZone || !isObject(interval) ||
      !finiteDate(interval.startMs) || !finiteDate(interval.endMs) || interval.startMs >= interval.endMs ||
      !finiteDate(value.queriedAtMs) || !isObject(metrics)) throw new Error("Invalid Apple Health summary response");
  const units: Record<string, string> = {
    steps: "count", heartRate: "bpm", restingHeartRate: "bpm", hrv: "ms", oxygenSaturation: "fraction",
  };
  for (const [name, unit] of Object.entries(units)) {
    if (!validMetric(metrics[name], unit, name === "steps")) throw new Error("Invalid Apple Health summary response");
  }
  return value as AppleHealthSummary;
}

function validMetric(value: unknown, unit: string, aggregate: boolean): value is AppleHealthMetric | null {
  if (value === null) return true;
  if (!isObject(value) || value.unit !== unit || typeof value.value !== "number" || !Number.isFinite(value.value)) return false;
  if (aggregate) return value.sampleAtMs === undefined && value.source === undefined;
  if (!finiteDate(value.sampleAtMs) || !isObject(value.source)) return false;
  return typeof value.source.name === "string" && Boolean(value.source.name) &&
    typeof value.source.bundleIdentifier === "string" && Boolean(value.source.bundleIdentifier);
}

function validRecords(value: readonly R1HealthSampleRecord[]): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) return false;
  const identifiers = new Set<string>();
  const now = Date.now();
  return value.every(record => isObject(record) && Object.keys(record).length === 6 &&
    validRecordValue(record as R1HealthSampleRecord) &&
    finiteDate(record.startMs) && record.startMs >= 1_577_836_800_000 && finiteDate(record.endMs) &&
    record.endMs <= now && validRecordInterval(record as R1HealthSampleRecord) &&
    typeof record.syncIdentifier === "string" && record.syncIdentifier === record.syncIdentifier.trim() &&
    record.syncIdentifier.length > 0 && record.syncIdentifier.length <= 128 && !identifiers.has(record.syncIdentifier) &&
    identifiers.add(record.syncIdentifier) && Number.isInteger(record.syncVersion) && record.syncVersion > 0 &&
    record.syncVersion <= 2_147_483_647);
}

function validRecordValue(record: R1HealthSampleRecord): boolean {
  const value = record.value;
  if (!Number.isFinite(value)) return false;
  switch (record.type) {
    case "heartRate": return value >= 20 && value <= 300;
    case "oxygenSaturation": return value > 0 && value <= 1;
    case "stepCount": return Number.isInteger(value) && value >= 0 && value <= 4095;
    case "activeEnergyBurned": return Number.isInteger(value) && value >= 0 && value <= 1023;
    case "sleepAnalysis": return Number.isInteger(value) && value >= 2 && value <= 5;
    default: return false;
  }
}

function validRecordInterval(record: R1HealthSampleRecord): boolean {
  const duration = record.endMs - record.startMs;
  switch (record.type) {
    case "heartRate": case "oxygenSaturation": return duration === 0;
    case "stepCount": case "activeEnergyBurned": return duration === 600_000;
    case "sleepAnalysis": return duration > 0 && duration <= 86_400_000 && duration % 30_000 === 0;
    default: return false;
  }
}

function finiteDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function nativeError(value: Record<string, unknown>): string | null {
  return isObject(value.error) && typeof value.error.message === "string" && value.error.message
    ? value.error.message : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
