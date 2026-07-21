import type { PersonPosition } from './types.js';

export type MotionStateUpdater = (detected: boolean) => void;

export type MotionTimerScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const systemTimerScheduler: MotionTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class MotionSensorController {
  private deadline = 0;
  private timer?: unknown;
  private active = false;
  private stopped = false;

  public constructor(
    private readonly resetMs: number,
    private readonly updateState: MotionStateUpdater,
    private readonly now: () => number = Date.now,
    private readonly scheduler: MotionTimerScheduler = systemTimerScheduler,
  ) {}

  public personSeen(person: Pick<PersonPosition, 'timestamp'>): void {
    if (this.stopped) {
      return;
    }

    const now = this.now();
    const deadline = person.timestamp + this.resetMs;
    if (deadline <= now || deadline <= this.deadline) {
      return;
    }

    this.deadline = deadline;
    if (!this.active) {
      this.active = true;
      this.updateState(true);
    }
    this.reschedule(deadline - now);
  }

  public stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.clearTimer();
    this.deadline = 0;
    if (this.active) {
      this.active = false;
      this.updateState(false);
    }
  }

  private reschedule(delayMs: number): void {
    this.clearTimer();
    const scheduledDeadline = this.deadline;
    this.timer = this.scheduler.setTimeout(() => {
      this.handleTimer(scheduledDeadline);
    }, delayMs);
  }

  private handleTimer(scheduledDeadline: number): void {
    if (this.stopped || scheduledDeadline !== this.deadline) {
      return;
    }

    const remainingMs = this.deadline - this.now();
    if (remainingMs > 0) {
      this.reschedule(remainingMs);
      return;
    }

    this.timer = undefined;
    this.deadline = 0;
    if (this.active) {
      this.active = false;
      this.updateState(false);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
