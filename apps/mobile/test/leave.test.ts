import { describe, expect, it } from 'vitest';

import { leaveChain } from '../src/lib/leave';

describe('leaving a chain', () => {
  it('forgets the chain without waiting for a server that does not answer', async () => {
    const order: string[] = [];
    let told: string | null = null;
    const left = leaveChain({
      deviceId: async () => {
        order.push('id');
        return 'phone-1';
      },
      forget: async () => {
        order.push('forget');
      },
      tellServer: (id) => {
        told = id;
        return new Promise<void>(() => undefined);
      },
    });
    await expect(left).resolves.toBeUndefined();
    expect(order).toEqual(['id', 'forget']);
    expect(told).toBe('phone-1');
  });

  it('reads the device id before forgetting removes it', async () => {
    let stored: string | null = 'phone-2';
    let told: string | null = null;
    await leaveChain({
      deviceId: async () => stored ?? 'new-id',
      forget: async () => {
        stored = null;
      },
      tellServer: async (id) => {
        told = id;
      },
    });
    expect(told).toBe('phone-2');
  });

  it('a server that refuses or is gone does not make leaving fail', async () => {
    await expect(
      leaveChain({ deviceId: async () => 'phone-3', forget: async () => undefined, tellServer: async () => Promise.reject(new TypeError('Network request failed')) }),
    ).resolves.toBeUndefined();
  });

  it('a failure to forget is reported, and the server is not told', async () => {
    let told = false;
    await expect(
      leaveChain({
        deviceId: async () => 'phone-4',
        forget: async () => Promise.reject(new Error('disk full')),
        tellServer: async () => {
          told = true;
        },
      }),
    ).rejects.toThrow('disk full');
    expect(told).toBe(false);
  });
});
