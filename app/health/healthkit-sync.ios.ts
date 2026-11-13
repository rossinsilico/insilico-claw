import { File } from '@nativescript/core';
import { getBooleanSetting, setBooleanSetting } from '../native/settings-store';
import { isAppleHealthAvailable, writeR1HealthSamples } from '../native/apple-health';
import { healthFolder, healthStore, checkedFileOperation } from './health-store-files';
import { syncLiveRecords } from './health-live';
import { hasLiveData, isFixtureData } from './health-seed';
import { buildR1HealthKitExport, buildR1SleepHealthKitExport } from './healthkit-export';

const AUTOMATIC_SYNC_KEY = 'health.apple.automaticR1Sync';
const HISTORY_MS = 7 * 86_400_000;
type Receipt = { revision: number; endMs: number };
type Receipts = Record<string, Receipt>;
let running: Promise<boolean> | null = null;
let pending = false;

export function isAutomaticR1HealthSyncEnabled(): boolean {
  return getBooleanSetting(AUTOMATIC_SYNC_KEY, false);
}

export function setAutomaticR1HealthSyncEnabled(enabled: boolean): void {
  setBooleanSetting(AUTOMATIC_SYNC_KEY, enabled);
}

/** One drain per transfer/resume, never a polling timer or a permission prompt. */
export function syncAutomaticR1Health(): Promise<boolean> {
  if (running) { pending = true; return running; }
  running = drain().finally(() => { running = null; });
  return running;
}

async function drain(): Promise<boolean> {
  let expired = false, task = UIBackgroundTaskInvalid;
  const endTask = () => {
    if (task === UIBackgroundTaskInvalid) return;
    const ended = task; task = UIBackgroundTaskInvalid;
    UIApplication.sharedApplication.endBackgroundTask(ended);
  };
  try {
    task = UIApplication.sharedApplication.beginBackgroundTaskWithNameExpirationHandler('R1 health sync', () => {
      expired = true; endTask();
    });
    if (expired) { endTask(); return false; }
    do {
      pending = false;
      // The native watermark advances only after both local writes succeed.
      syncLiveRecords();
      if (!isAutomaticR1HealthSyncEnabled() || !isAppleHealthAvailable() || !hasLiveData() || isFixtureData()) return false;
      const now = Date.now(), start = now - HISTORY_MS;
      const store = healthStore(), options = { nowMs: now, startMs: start, endMs: now };
      const records = [
        ...buildR1HealthKitExport([...store.readingsInRange(start, now), ...store.samplesInRange(start, now)], options).samples,
        ...buildR1SleepHealthKitExport(store.sleepSessions(), options).samples,
      ];
      const receiptPath = `${healthFolder().path}/healthkit-receipts.json`;
      const receipts = readReceipts(receiptPath, start, now);
      const unsaved = records.filter(record => (receipts[record.syncIdentifier]?.revision ?? 0) < record.syncVersion);
      let failure: unknown;
      // HealthKit permissions are per type; a denied category must not block the rest.
      for (const type of new Set(unsaved.map(record => record.type))) {
        const sameType = unsaved.filter(record => record.type === type);
        for (let offset = 0; offset < sameType.length; offset += 1000) {
          if (expired || !isAutomaticR1HealthSyncEnabled()) return false;
          const batch = sameType.slice(offset, offset + 1000);
          try { await writeR1HealthSamples(batch); }
          catch (error) { failure ??= error; break; }
          // An uncertain receipt is retried with the same native sync identifiers.
          for (const record of batch) receipts[record.syncIdentifier] = { revision: record.syncVersion, endMs: record.endMs };
          checkedFileOperation(onError => File.fromPath(receiptPath).writeTextSync(JSON.stringify({ version: 1, entries: receipts }), onError));
        }
      }
      if (failure) throw failure;
    } while (pending && !expired);
    return !expired && isAutomaticR1HealthSyncEnabled();
  } finally { endTask(); }
}

function readReceipts(file: string, startMs: number, nowMs: number): Receipts {
  if (!File.exists(file)) return {};
  let text = '';
  checkedFileOperation(onError => { text = File.fromPath(file).readTextSync(onError); });
  try {
    const value = JSON.parse(text);
    if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return {};
    const receipts: Receipts = {};
    for (const [id, row] of Object.entries(value.entries) as [string, Receipt][]) {
      if (id.startsWith('faceclaw-r1|') && id.length <= 128 && row &&
          Number.isInteger(row.revision) && row.revision > 0 && row.revision <= 2_147_483_647 &&
          Number.isInteger(row.endMs) && row.endMs >= startMs && row.endMs <= nowMs) receipts[id] = row;
    }
    return receipts;
  } catch {
    // A damaged receipt can safely resubmit; the health data and native IDs remain intact.
    console.warn('R1 HealthKit receipt could not be decoded; verified records will be retried.');
    return {};
  }
}
