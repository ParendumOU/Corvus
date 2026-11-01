import { describe, expect, it } from 'vitest';

import { REFUSED_WITHIN_MS, SignInMemory, signInPrompt } from '../src/lib/http-auth';

describe('sign-in prompt', () => {
  it('names the site and its realm', () => {
    expect(signInPrompt('router.example:8080', '  Router\n admin ', 'https://router.example:8080/')).toEqual({ site: 'router.example:8080', realm: 'Router admin', private: true });
  });

  it('warns only when the page is the same site over plain http', () => {
    expect(signInPrompt('panel.example', '', 'http://panel.example/status').private).toBe(false);
    expect(signInPrompt('Panel.Example', '', 'http://panel.example/').private).toBe(false);
    expect(signInPrompt('panel.example', '', 'https://panel.example/').private).toBe(true);
    expect(signInPrompt('panel.example', '', 'http://other.example/').private).toBe(true);
    expect(signInPrompt('panel.example', '', '').private).toBe(true);
  });

  it('shortens a long realm', () => {
    const realm = signInPrompt('a.example', 'x'.repeat(500), '').realm;
    expect(realm).toHaveLength(200);
    expect(realm.endsWith('...')).toBe(true);
  });
});

describe('sign-in memory', () => {
  it('recalls the username a tab sent and whether the site asks again right after', () => {
    const memory = new SignInMemory();
    expect(memory.recall('t1', 'a.example', 'r', 0)).toEqual({ username: '', refused: false });
    memory.remember('t1', 'A.example', 'r', 'admin', 1000);
    expect(memory.recall('t1', 'a.example', 'r', 2000)).toEqual({ username: 'admin', refused: true });
    expect(memory.recall('t1', 'a.example', 'r', 1000 + REFUSED_WITHIN_MS)).toEqual({ username: 'admin', refused: false });
    expect(memory.recall('t2', 'a.example', 'r', 2000).username).toBe('');
    expect(memory.recall('t1', 'a.example', 'other', 2000).username).toBe('');
  });

  it('forgets the tabs that closed', () => {
    const memory = new SignInMemory();
    memory.remember('t1', 'a.example', '', 'admin', 0);
    memory.remember('t10', 'a.example', '', 'root', 0);
    memory.keepTabs(new Set(['t10', 't2']));
    expect(memory.recall('t1', 'a.example', '', 1).username).toBe('');
    expect(memory.recall('t10', 'a.example', '', 1).username).toBe('root');
  });
});
