/** What leaving a chain does: read this phone's device id, forget the chain, tell its server. */
export interface LeaveSteps {
  deviceId: () => Promise<string>;
  forget: () => Promise<void>;
  tellServer: (deviceId: string) => Promise<void>;
}

/**
 * Leaves a chain: the phone forgets it at once and its server is told afterwards, in the
 * background. A server that cannot be reached (the computer that runs it is off, or its firewall
 * drops the connection without answering) would otherwise keep the person waiting for the whole
 * request timeout. When the server never hears of it, the phone stays in the chain's device list
 * until a computer removes it; the other devices sync as before.
 */
export async function leaveChain(steps: LeaveSteps): Promise<void> {
  // Read first: forgetting the chain removes the stored id.
  const deviceId = await steps.deviceId();
  await steps.forget();
  void steps.tellServer(deviceId).catch(() => undefined);
}
