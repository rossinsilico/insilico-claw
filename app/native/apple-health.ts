import type {
  AppleHealthAccessResult,
  AppleHealthSummary,
  AppleHealthWriteResult,
  R1HealthSampleRecord,
  ToolCallSignal,
} from "./apple-health-types";

export type { AppleHealthSummary, R1HealthSampleRecord } from "./apple-health-types";

const unavailable = (): never => { throw new Error("Apple Health is only available on iOS"); };

export function isAppleHealthAvailable(): boolean { return false; }
export async function requestAppleHealthAccess(): Promise<AppleHealthAccessResult> { return unavailable(); }
export async function readAppleHealthSummary(
  _day: "today" | "yesterday",
  _signal?: ToolCallSignal,
): Promise<AppleHealthSummary> { return unavailable(); }
export async function writeR1HealthSamples(
  _records: readonly R1HealthSampleRecord[],
  _signal?: ToolCallSignal,
): Promise<AppleHealthWriteResult> { return unavailable(); }
