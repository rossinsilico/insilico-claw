import { type HealthSample, type SleepSession, type R1SampleProvenance } from "./health-types";

export type R1HealthKitExportRecord = {
  type: "heartRate" | "oxygenSaturation" | "stepCount" | "activeEnergyBurned" | "sleepAnalysis";
  value: number;
  startMs: number;
  endMs: number;
  syncIdentifier: string;
  syncVersion: number;
};

export type R1HealthKitExportOptions = {
  nowMs: number;
  startMs: number;
  endMs: number;
};

const EARLIEST_HEALTHKIT_MS = 1_577_836_800_000;
const MAX_SYNC_VERSION = 2_147_483_647;

export function buildR1HealthKitExport(
  input: readonly HealthSample[],
  options: R1HealthKitExportOptions,
): { samples: R1HealthKitExportRecord[]; excluded: number } {
  if (!validWindow(options)) {
    return { samples: [], excluded: input.length };
  }
  const samples: R1HealthKitExportRecord[] = [];
  for (const sample of input) {
    const record = exportRecord(sample, options);
    if (record) samples.push(record);
  }
  return { samples, excluded: input.length - samples.length };
}

function exportRecord(
  sample: HealthSample,
  options: R1HealthKitExportOptions,
): R1HealthKitExportRecord | null {
  const provenance = sample.provenance;
  const endMs = sample.startMs + sample.spanMs;
  const point = sample.metric === "heartRate" || sample.metric === "spo2";
  const activity = sample.metric === "steps" || sample.metric === "activeCalories";
  if ((!point && !activity) || !validOrigin(provenance, options) || !finiteSample(sample) ||
      !validTimes(sample.startMs, endMs, provenance, options)) return null;
  if (point ? provenance.dateSource !== "ring-latest" || sample.spanMs !== 0 || sample.startMs >= options.endMs
      : provenance.dateSource !== "ring-anchor" || sample.spanMs !== 600_000) return null;
  if (!validRange(sample)) return null;

  const syncIdentifier = `faceclaw-r1|${provenance.ringId}|${sample.metric}|${point ? "point" : "bucket"}|${sample.startMs}`;
  if (syncIdentifier.length > 128) return null;
  return {
    type: sample.metric === "heartRate" ? "heartRate" : sample.metric === "spo2" ? "oxygenSaturation"
      : sample.metric === "steps" ? "stepCount" : "activeEnergyBurned",
    value: sample.metric === "spo2" ? sample.avg / 100 : sample.total,
    startMs: sample.startMs,
    endMs,
    syncIdentifier,
    syncVersion: provenance.exportRevision,
  };
}

function finiteSample(sample: HealthSample): boolean {
  return Number.isFinite(sample.startMs) && Number.isFinite(sample.spanMs) &&
    Number.isFinite(sample.min) && Number.isFinite(sample.max) && Number.isFinite(sample.avg) &&
    Number.isFinite(sample.total) && sample.min === sample.avg && sample.avg === sample.max && sample.total === sample.avg;
}

function validRange(sample: HealthSample): boolean {
  if (sample.metric === "heartRate") return sample.min >= 20 && sample.max <= 300;
  if (sample.metric === "spo2") return sample.min > 0 && sample.max <= 100;
  return Number.isInteger(sample.total) && sample.total >= 0 &&
    sample.total <= (sample.metric === "steps" ? 4095 : 1023);
}

function validOrigin(value: R1SampleProvenance | undefined, options: R1HealthKitExportOptions): value is R1SampleProvenance {
  return Boolean(value && value.kind === "r1-live" && typeof value.ringId === "string" && value.ringId.trim() &&
    value.ringId === value.ringId.trim() && Number.isFinite(value.receivedAtMs) && value.receivedAtMs <= options.nowMs &&
    Number.isInteger(value.exportRevision) && value.exportRevision > 0 && value.exportRevision <= MAX_SYNC_VERSION);
}

function validTimes(startMs: number, endMs: number, origin: R1SampleProvenance, options: R1HealthKitExportOptions): boolean {
  return Number.isInteger(startMs) && Number.isInteger(endMs) && startMs >= EARLIEST_HEALTHKIT_MS &&
    startMs >= options.startMs && endMs >= startMs && endMs <= options.endMs && endMs <= options.nowMs && endMs <= origin.receivedAtMs;
}

/** Source mapping: R1 awake/REM/light/deep to HealthKit awake/REM/core/deep. */
const APPLE_SLEEP_STAGE = [2, 5, 3, 4] as const;

function validWindow(options: R1HealthKitExportOptions): boolean {
  return Number.isFinite(options.nowMs) && Number.isFinite(options.startMs) &&
    Number.isFinite(options.endMs) && options.startMs <= options.endMs;
}

export function buildR1SleepHealthKitExport(
  input: readonly SleepSession[], options: R1HealthKitExportOptions,
): { samples: R1HealthKitExportRecord[]; excluded: number } {
  if (!validWindow(options)) return { samples: [], excluded: input.length };
  const samples: R1HealthKitExportRecord[] = [];
  let excluded = 0;
  for (const session of input) {
    const origin = session.provenance;
    if (!session.timeResolved || !validOrigin(origin, options) || origin.dateSource !== "ring-sleep" ||
        !validTimes(session.startMs, session.endMs, origin, options) || session.endMs <= session.startMs ||
        session.endMs - session.startMs > 86_400_000 || origin.exportRevision !== 1 ||
        !Array.isArray(session.segments) || !session.segments.length) {
      excluded++; continue;
    }
    // shortcut: hold corrected nights until owned HealthKit stage replacement is implemented; removed runs otherwise remain stale.
    const totals = [0, 0, 0, 0];
    let cursor = session.startMs;
    const records: R1HealthKitExportRecord[] = [];
    for (const [index, run] of session.segments.entries()) {
      if (!Number.isInteger(run.stageId) || run.stageId < 0 || run.stageId > 3 ||
          !Number.isInteger(run.halfMinutes) || run.halfMinutes <= 0 || run.halfMinutes > 65535) break;
      const endMs = cursor + run.halfMinutes * 30_000;
      const syncIdentifier = `faceclaw-r1|${origin.ringId}|sleep|${session.startMs}|${index}`;
      if (endMs > session.endMs || syncIdentifier.length > 128) break;
      totals[run.stageId] += run.halfMinutes * 30;
      records.push({ type: "sleepAnalysis", value: APPLE_SLEEP_STAGE[run.stageId], startMs: cursor, endMs,
        syncIdentifier, syncVersion: origin.exportRevision });
      cursor = endMs;
    }
    if (records.length !== session.segments.length || cursor !== session.endMs ||
        totals[0] !== session.wakeSec || totals[1] !== session.remSec || totals[2] !== session.lightSec ||
        totals[3] !== session.deepSec || totals[1] + totals[2] + totals[3] !== session.totalSec) {
      excluded++; continue;
    }
    samples.push(...records);
  }
  return { samples, excluded };
}
