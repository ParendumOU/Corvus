import { describe, expect, it } from 'vitest';

import { certErrorOf } from '../src/lib/cert-errors';

describe('certificate errors', () => {
  it('reads the kind of an Android SSL error', () => {
    expect(certErrorOf(undefined, 3, 'android')).toBe('authority');
    expect(certErrorOf(undefined, 1, 'android')).toBe('expired');
    expect(certErrorOf(undefined, 0, 'android')).toBe('not-yet-valid');
    expect(certErrorOf(undefined, 2, 'android')).toBe('name');
    expect(certErrorOf(undefined, 4, 'android')).toBe('date');
    expect(certErrorOf(undefined, 5, 'android')).toBe('invalid');
  });

  it('leaves other Android load errors to the generic page', () => {
    expect(certErrorOf(undefined, -2, 'android')).toBeNull();
    // A failed TLS handshake is not a certificate the person could judge.
    expect(certErrorOf(undefined, -11, 'android')).toBeNull();
    expect(certErrorOf(undefined, 6, 'android')).toBeNull();
  });

  it('reads the kind of an iOS certificate error', () => {
    expect(certErrorOf('NSURLErrorDomain', -1202, 'ios')).toBe('untrusted');
    expect(certErrorOf('NSURLErrorDomain', -1203, 'ios')).toBe('authority');
    expect(certErrorOf('NSURLErrorDomain', -1201, 'ios')).toBe('date');
    expect(certErrorOf('NSURLErrorDomain', -1204, 'ios')).toBe('not-yet-valid');
  });

  it('leaves other iOS load errors to the generic page', () => {
    expect(certErrorOf('NSURLErrorDomain', -1200, 'ios')).toBeNull();
    expect(certErrorOf('NSURLErrorDomain', -1206, 'ios')).toBeNull();
    expect(certErrorOf('NSURLErrorDomain', -1009, 'ios')).toBeNull();
    expect(certErrorOf('WebKitErrorDomain', -1202, 'ios')).toBeNull();
  });

  it('knows no certificate errors elsewhere', () => {
    expect(certErrorOf(undefined, 3, 'web')).toBeNull();
  });
});
