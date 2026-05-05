import { channelBanditStore } from './channelBanditStore.js';

let decayTimer: ReturnType<typeof setInterval> | null = null;

export function startChannelBanditDecayScheduler(): void {
  if (decayTimer || process.env.NODE_ENV === 'test') return;
  decayTimer = setInterval(() => {
    void channelBanditStore.runDecay()
      .then(() => channelBanditStore.flushDirty())
      .catch((error) => {
      console.warn('[routing-bandit] periodic flush failed', error);
      });
  }, 60_000);
  decayTimer.unref?.();
}

export function stopChannelBanditDecayScheduler(): void {
  if (!decayTimer) return;
  clearInterval(decayTimer);
  decayTimer = null;
}
