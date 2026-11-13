import type { ToolCallSignal } from "../assistant/tool-registry";

export type AppleHealthMetric = {
  value: number;
  unit: string;
  sampleAtMs?: number;
  source?: { name: string; bundleIdentifier: string };
};

export type AppleHealthSummary = {
  ok: true;
  source: "apple-health";
  day: "today" | "yesterday";
  timeZone: string;
  interval: { startMs: number; endMs: number };
  queriedAtMs: number;
  metrics: {
    steps: AppleHealthMetric | null;
    heartRate: AppleHealthMetric | null;
    restingHeartRate: AppleHealthMetric | null;
    hrv: AppleHealthMetric | null;
    oxygenSaturation: AppleHealthMetric | null;
  };
};

export type AppleHealthAccessResult = {
  ok: true;
  requestCompleted: true;
  readAuthorization: "not_disclosed_by_healthkit";
};

export type R1HealthSampleRecord = {
  type: "heartRate" | "oxygenSaturation" | "stepCount" | "activeEnergyBurned" | "sleepAnalysis";
  value: number;
  startMs: number;
  endMs: number;
  syncIdentifier: string;
  syncVersion: number;
};

export type AppleHealthWriteResult = {
  ok: true;
  saveCompleted: true;
  submittedCount: number;
  requestId: string;
};

export type { ToolCallSignal };
