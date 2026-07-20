import { describe, expect, it } from 'vitest';
import { MotionSensorController } from './motionSensor.js';
import type { MotionTimerScheduler } from './motionSensor.js';

type ScheduledTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
};

class TestScheduler implements MotionTimerScheduler {
  public readonly timers: ScheduledTimer[] = [];

  public setTimeout(callback: () => void, delayMs: number): ScheduledTimer {
    const timer = { callback, delayMs, cleared: false };
    this.timers.push(timer);
    return timer;
  }

  public clearTimeout(handle: unknown): void {
    (handle as ScheduledTimer).cleared = true;
  }
}

describe('MotionSensorController', () => {
  it('uses event time for delayed detections and ignores expired history', () => {
    let now = 10_000;
    const scheduler = new TestScheduler();
    const states: boolean[] = [];
    const controller = new MotionSensorController(5_000, (state) => states.push(state), () => now, scheduler);

    controller.personSeen({ timestamp: 4_999 });
    expect(states).toEqual([]);
    expect(scheduler.timers).toHaveLength(0);

    controller.personSeen({ timestamp: 7_000 });
    expect(states).toEqual([true]);
    expect(scheduler.timers[0]?.delayMs).toBe(2_000);

    now = 12_000;
    scheduler.timers[0]?.callback();
    expect(states).toEqual([true, false]);
  });

  it('keeps the maximum deadline for duplicate and out-of-order detections', () => {
    let now = 1_000;
    const scheduler = new TestScheduler();
    const states: boolean[] = [];
    const controller = new MotionSensorController(5_000, (state) => states.push(state), () => now, scheduler);

    controller.personSeen({ timestamp: 1_000 });
    now = 2_000;
    controller.personSeen({ timestamp: 1_500 });
    controller.personSeen({ timestamp: 1_200 });
    controller.personSeen({ timestamp: 1_500 });

    expect(states).toEqual([true]);
    expect(scheduler.timers).toHaveLength(2);
    expect(scheduler.timers[0]?.cleared).toBe(true);
    expect(scheduler.timers[1]).toMatchObject({ delayMs: 4_500, cleared: false });

    now = 6_200;
    scheduler.timers[0]?.callback();
    expect(states).toEqual([true]);

    now = 6_500;
    scheduler.timers[1]?.callback();
    expect(states).toEqual([true, false]);
  });

  it('reschedules an early timer without clearing motion', () => {
    let now = 1_000;
    const scheduler = new TestScheduler();
    const states: boolean[] = [];
    const controller = new MotionSensorController(5_000, (state) => states.push(state), () => now, scheduler);

    controller.personSeen({ timestamp: 1_000 });
    now = 5_000;
    scheduler.timers[0]?.callback();

    expect(states).toEqual([true]);
    expect(scheduler.timers[1]?.delayMs).toBe(1_000);

    now = 6_000;
    scheduler.timers[1]?.callback();
    expect(states).toEqual([true, false]);
  });

  it('clears motion and rejects timer races after shutdown', () => {
    let now = 1_000;
    const scheduler = new TestScheduler();
    const states: boolean[] = [];
    const controller = new MotionSensorController(5_000, (state) => states.push(state), () => now, scheduler);

    controller.personSeen({ timestamp: 1_000 });
    const pending = scheduler.timers[0];
    controller.stop();

    expect(pending?.cleared).toBe(true);
    expect(states).toEqual([true, false]);

    now = 6_000;
    pending?.callback();
    controller.personSeen({ timestamp: 6_000 });
    controller.stop();
    expect(states).toEqual([true, false]);
    expect(scheduler.timers).toHaveLength(1);
  });
});
