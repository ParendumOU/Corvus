/**
 * Chromium net errors where the server never answered: its name did not resolve, no connection was
 * made, or the connection ended before any response. Blocked requests, bad addresses, certificate
 * errors and pages the server did send (404, 500) are not among them.
 */
const NO_RESPONSE_CODES: ReadonlySet<number> = new Set([
  -7, // TIMED_OUT
  -15, // SOCKET_NOT_CONNECTED
  -21, // NETWORK_CHANGED
  -100, // CONNECTION_CLOSED
  -101, // CONNECTION_RESET
  -102, // CONNECTION_REFUSED
  -103, // CONNECTION_ABORTED
  -104, // CONNECTION_FAILED
  -105, // NAME_NOT_RESOLVED
  -106, // INTERNET_DISCONNECTED
  -109, // ADDRESS_UNREACHABLE
  -118, // CONNECTION_TIMED_OUT
  -120, // SOCKS_CONNECTION_FAILED
  -130, // PROXY_CONNECTION_FAILED
  -137, // NAME_RESOLUTION_FAILED
  -324, // EMPTY_RESPONSE
]);

/** Whether a did-fail-load error code means the server gave no response at all. */
export function isNoResponseError(code: number): boolean {
  return NO_RESPONSE_CODES.has(code);
}
