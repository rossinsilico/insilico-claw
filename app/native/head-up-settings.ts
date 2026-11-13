type HeadUpSession = {
  isSessionReady(): boolean;
  readHeadUpAngle(stillCurrent?: () => boolean): Promise<number>;
  setHeadUpAngle(angle: number, stillCurrent?: () => boolean): Promise<boolean>;
};

let session: HeadUpSession | null = null;
let generation = 0;
let revision = 0;
let angle: number | null = null;
let write: object | null = null;

export function bindHeadUpSettingsSession(next: HeadUpSession | null): void {
  if (session === next) return;
  session = next;
  generation++;
  revision++;
  angle = null;
  write = null;
}

export function headUpSettingsGeneration(): number { return generation; }

export function isHeadUpSettingsAvailable(): boolean {
  return session?.isSessionReady() ?? false;
}

export function headUpAngleValue(): string {
  return angle === null ? 'Not read' : `${angle}°`;
}

function validAngle(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 60;
}

export async function refreshHeadUpAngle(): Promise<number | null> {
  const target = session, expectedGeneration = generation, expectedRevision = ++revision;
  if (!target || !target.isSessionReady()) return null;
  try {
    const value = await target.readHeadUpAngle(() => session === target && generation === expectedGeneration && target.isSessionReady());
    if (session !== target || generation !== expectedGeneration || revision !== expectedRevision) return null;
    angle = validAngle(value) ? value : null;
    return angle;
  } catch (error) {
    if (session === target && generation === expectedGeneration && revision === expectedRevision) angle = null;
    throw error;
  }
}

export async function setHeadUpAngle(value: number, expectedGeneration: number): Promise<void> {
  if (!validAngle(value)) throw new Error('Choose a whole number from 0 to 60 degrees.');
  if (expectedGeneration !== generation) throw new Error('The glasses connection changed. Open this setting again.');
  const target = session;
  if (!target || !target.isSessionReady()) throw new Error('Connect your G2 glasses before changing the angle.');
  if (write) throw new Error('An angle change is already in progress.');
  const token = write = {};
  const expectedRevision = ++revision;
  try {
    const confirmed = await target.setHeadUpAngle(value,
      () => session === target && generation === expectedGeneration && target.isSessionReady());
    if (session !== target || generation !== expectedGeneration || !target.isSessionReady()) {
      throw new Error('The glasses connection changed. Open this setting again.');
    }
    if (!confirmed) throw new Error('The angle was not confirmed on both lenses. Reopen this setting to check their values.');
    if (revision === expectedRevision) angle = value;
  } catch (error) {
    if (session === target && generation === expectedGeneration && revision === expectedRevision) angle = null;
    throw error;
  } finally {
    if (write === token) write = null;
  }
}
