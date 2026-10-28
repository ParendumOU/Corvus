import { describe, expect, it } from 'vitest';

import { addressTarget, classifyAddress, displayAddress, engineById, isSecure, isWebPage, pickEngine, searchQueryOf } from '../src/lib/address';

const url = (input: string): string | null => {
  const intent = classifyAddress(input);
  return intent.kind === 'url' ? intent.url : null;
};

describe('the address bar', () => {
  it('opens what looks like a web address', () => {
    expect(url('example.com')).toBe('https://example.com/');
    expect(url('  Wikipedia.ORG/wiki/Crow ')).toBe('https://wikipedia.org/wiki/Crow');
    expect(url('es.wikipedia.org/wiki/Córvido?x=1#y')).toBe('https://es.wikipedia.org/wiki/Córvido?x=1#y');
    expect(url('http://example.com')).toBe('http://example.com');
    expect(url('https:example.com/a')).toBe('https://example.com/a');
    expect(url('HTTPS://Example.com/')).toBe('https://Example.com/');
    expect(url('bbc.co.uk')).toBe('https://bbc.co.uk/');
    expect(url('xn--bcher-kva.de')).toBe('https://xn--bcher-kva.de/');
  });

  it('opens local and intranet hosts over http', () => {
    expect(url('localhost:3000')).toBe('http://localhost:3000/');
    expect(url('192.168.1.10/admin')).toBe('http://192.168.1.10/admin');
    expect(url('[::1]:8080')).toBe('http://[::1]:8080/');
    expect(url('router/')).toBe('http://router/');
    expect(url('nas:5000')).toBe('http://nas:5000/');
  });

  it('searches for everything else', () => {
    for (const text of ['corvus browser', 'node.js', 'crow', 'me@example.com', '?example.com', '999.1.1.1', 'a..b.com', 'example.notatld']) {
      expect(classifyAddress(text).kind, text).toBe('search');
    }
    expect(classifyAddress('?example.com')).toEqual({ kind: 'search', query: 'example.com' });
  });

  it('never loads other schemes typed in it', () => {
    for (const text of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'intent://scan#Intent;end', 'corvus://settings', 'about:blank', 'mailto:me@example.com', 'https://']) {
      expect(classifyAddress(text).kind, text).toBe('search');
    }
  });

  it('searches with the engine picked, DuckDuckGo unless another was chosen here or on the computers', () => {
    expect(pickEngine(null, undefined)).toBe('duckduckgo');
    expect(pickEngine(null, 'brave')).toBe('brave');
    expect(pickEngine(null, 'bing')).toBe('duckduckgo');
    expect(pickEngine(null, 'corvus')).toBe('duckduckgo');
    expect(pickEngine('startpage', 'google')).toBe('startpage');
    expect(pickEngine('nope', 'google')).toBe('google');
    expect(engineById('google').search('crows & ravens')).toBe('https://www.google.com/search?q=crows%20%26%20ravens');
    expect(engineById('startpage').search('a')).toBe('https://www.startpage.com/do/search?query=a');
    expect(engineById('x').id).toBe('duckduckgo');
    expect(addressTarget('what do crows eat', engineById('duckduckgo'))).toBe('https://duckduckgo.com/?q=what%20do%20crows%20eat');
    expect(addressTarget('example.com', engineById('duckduckgo'))).toBe('https://example.com/');
    expect(addressTarget('   ', engineById('duckduckgo'))).toBeNull();
  });

  it('shows the search on a results page, else the host', () => {
    expect(displayAddress('https://duckduckgo.com/?q=crows+eat&t=h_')).toBe('crows eat');
    expect(displayAddress('https://search.brave.com/search?q=ravens')).toBe('ravens');
    expect(displayAddress('https://www.google.es/search?q=c%C3%B3rvidos')).toBe('córvidos');
    expect(displayAddress('https://www.startpage.com/do/search?query=x')).toBe('x');
    expect(displayAddress('https://www.wikipedia.org/wiki/Crow')).toBe('wikipedia.org');
    expect(displayAddress('http://localhost:3000/a')).toBe('localhost:3000');
    expect(displayAddress('about:blank')).toBe('');
    expect(searchQueryOf('https://duckduckgo.com/about')).toBeNull();
    expect(searchQueryOf('http://duckduckgo.com/?q=x')).toBeNull();
  });

  it('tells web pages and secure ones', () => {
    expect(isWebPage('https://a.com/x')).toBe(true);
    expect(isWebPage('about:blank')).toBe(false);
    expect(isWebPage('https://')).toBe(false);
    expect(isSecure('https://a.com')).toBe(true);
    expect(isSecure('http://a.com')).toBe(false);
  });
});
