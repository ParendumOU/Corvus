import { describe, expect, it } from 'vitest';

import { systemPath, webLink } from '../src/lib/links';

describe('links the system hands the app', () => {
  it('sends a share from another app to the Send screen', () => {
    expect(systemPath('corvus://expo-sharing')).toBe('/send');
    expect(systemPath('corvus://expo-sharing?x=1')).toBe('/send');
  });

  it('sends a web link Corvus opens as the browser to the Open screen, address intact', () => {
    const url = 'https://news.example/a b?q=1&r=2#top';
    expect(systemPath('https://news.example/article?q=1&r=2#top')).toBe(`/open?url=${encodeURIComponent('https://news.example/article?q=1&r=2#top')}`);
    expect(systemPath('http://example.com')).toBe('/open?url=http%3A%2F%2Fexample.com');
    expect(systemPath('HTTPS://Example.com/')).toBe('/open?url=HTTPS%3A%2F%2FExample.com%2F');
    expect(systemPath(url)).toBe(`/open?url=${encodeURIComponent(url)}`);
  });

  it("leaves the app's own links and other addresses as they are", () => {
    expect(systemPath('corvus://watches')).toBe('corvus://watches');
    expect(systemPath('/settings')).toBe('/settings');
    expect(systemPath('ftp://example.com/file')).toBe('ftp://example.com/file');
    expect(systemPath('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('accepts only http and https links with a host', () => {
    expect(webLink(' https://example.com/x ')).toBe('https://example.com/x');
    expect(webLink('https://')).toBeNull();
    expect(webLink('https:///path')).toBeNull();
    expect(webLink('file:///etc/passwd')).toBeNull();
    expect(webLink('intent://example.com#Intent;end')).toBeNull();
    expect(webLink('')).toBeNull();
  });
});
