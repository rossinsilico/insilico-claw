import { scheduleTimeout, type ScheduleFn } from "./notification-popup-delay";

export type NotificationPopupPresentation = { token: number; startedAt: number; durationMs: number };
let nextTimeline = 1;

/**
 * Closes a new-notification popup that is left untouched for its timeout
 * ("Display new notifications"). The host restarts the countdown when the
 * popup opens and on each interaction with it (any input, including moving
 * its menu selection), and stops it when the popup goes away.
 */
export class NotificationPopupTimeout {
  private cancel: (() => void) | null = null;
  private current: NotificationPopupPresentation | null = null;
  private covered = false;

  /** `timeoutMs` null never expires (the popup stays until dismissed). */
  constructor(
    private readonly timeoutMs: number | null,
    private readonly expired: () => void,
    private readonly schedule: ScheduleFn = scheduleTimeout,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start the countdown over. */
  restart(): void {
    this.stop();
    if (this.timeoutMs === null || this.covered) return;
    this.current = { token: nextTimeline++, startedAt: this.now(), durationMs: this.timeoutMs };
    this.cancel = this.schedule(() => this.reconcile(), this.timeoutMs);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.current = null;
  }

  /** Host timers can be suspended: consult the same absolute clock before input or paint. */
  reconcile(): boolean {
    if (!this.current || this.now() < this.current.startedAt + this.current.durationMs) return false;
    this.stop();
    this.expired();
    return true;
  }

  /** A higher overlay owns interaction; resume with a full reading interval when uncovered. */
  setCovered(covered: boolean): void {
    if (this.covered === covered) return;
    this.covered = covered;
    if (covered) this.stop();
    else this.restart();
  }

  presentation(): NotificationPopupPresentation | null { return this.current; }

  /** Whether a countdown is running (for tests). */
  isRunning(): boolean {
    return this.cancel !== null;
  }
}
