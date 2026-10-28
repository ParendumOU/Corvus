import { describe, expect, it } from 'vitest';

import { buildNotices, copyrightLines, mavenNotice, packageRootsOfSources, parsePom, sourcesOfMap, spdxOfMavenLicense } from '../scripts/notices-lib.mjs';
import { filterNotices, isNotices, noticeCount, reflowLicense, type Notices } from '../src/lib/notices';

describe('packageRootsOfSources', () => {
  it('keeps one root per npm package of the bundle, pnpm layout included, and leaves first-party files out', () => {
    const roots = packageRootsOfSources(
      [
        '/workspace/node_modules/.pnpm/react@19.3.0/node_modules/react/index.js',
        '/workspace/node_modules/.pnpm/react@19.3.0/node_modules/react/cjs/react.production.js',
        '/workspace/node_modules/.pnpm/@expo+vector-icons@15.0.0/node_modules/@expo/vector-icons/build/Icons.js',
        '../../node_modules/.pnpm/buffer@6.0.3/node_modules/buffer/index.js',
        '/workspace/apps/mobile/src/app/_layout.tsx',
        '/workspace/packages/shared/dist/index.js',
        '__prelude__',
        null,
      ],
      '/workspace/apps/mobile',
    );
    expect(roots).toEqual([
      '/workspace/node_modules/.pnpm/@expo+vector-icons@15.0.0/node_modules/@expo/vector-icons',
      '/workspace/node_modules/.pnpm/buffer@6.0.3/node_modules/buffer',
      '/workspace/node_modules/.pnpm/react@19.3.0/node_modules/react',
    ]);
  });
});

describe('copyrightLines', () => {
  it('finds the holders in a licence text, not the licence wording', () => {
    const mit = 'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nPermission is hereby granted... The above copyright notice and this permission notice shall be included';
    expect(copyrightLines(mit)).toEqual(['Copyright (c) Meta Platforms, Inc. and affiliates.']);
    const apache = 'Copyright [yyyy] [name of copyright owner]\n   Copyright 2015 Square, Inc.\n * Copyright 2015 Square, Inc.\n© 2020 Someone';
    expect(copyrightLines(apache)).toEqual(['Copyright 2015 Square, Inc.', '© 2020 Someone']);
    expect(copyrightLines('')).toEqual([]);
  });
});

const POM = `<?xml version="1.0"?>
<project>
  <!-- <name>commented out</name> -->
  <parent><groupId>com.squareup.okhttp3</groupId><artifactId>parent</artifactId><version>4.12.0</version></parent>
  <groupId>com.squareup.okhttp3</groupId>
  <artifactId>okhttp</artifactId>
  <version>4.12.0</version>
  <name>okhttp</name>
  <url>https://square.github.io/okhttp/</url>
  <licenses>
    <license><name>The Apache Software License, Version 2.0</name><url>http://www.apache.org/licenses/LICENSE-2.0.txt</url></license>
  </licenses>
  <developers><developer><name>Square, Inc.</name></developer></developers>
  <dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId><name>not this</name></dependency></dependencies>
</project>`;

describe('parsePom', () => {
  it('reads the project, its licences, developers and parent, not those of its dependencies', () => {
    expect(parsePom(POM)).toEqual({
      name: 'okhttp',
      url: 'https://square.github.io/okhttp/',
      licenses: [{ name: 'The Apache Software License, Version 2.0', url: 'http://www.apache.org/licenses/LICENSE-2.0.txt' }],
      organization: '',
      developers: ['Square, Inc.'],
      parent: { group: 'com.squareup.okhttp3', name: 'parent', version: '4.12.0' },
    });
  });
});

describe('spdxOfMavenLicense', () => {
  it('maps the names POMs use to SPDX ids, by name or by address', () => {
    expect(spdxOfMavenLicense({ name: 'The Apache Software License, Version 2.0' })).toBe('Apache-2.0');
    expect(spdxOfMavenLicense({ name: 'Apache License 2.0' })).toBe('Apache-2.0');
    expect(spdxOfMavenLicense({ name: 'MIT License' })).toBe('MIT');
    expect(spdxOfMavenLicense({ name: 'New BSD License' })).toBe('BSD-3-Clause');
    expect(spdxOfMavenLicense({ name: '', url: 'https://www.apache.org/licenses/LICENSE-2.0' })).toBe('Apache-2.0');
    expect(spdxOfMavenLicense({ name: 'Android Software Development Kit License' })).toBe('Android-SDK');
    expect(spdxOfMavenLicense({ name: 'Something Custom' })).toBe('Something Custom');
  });
});

describe('mavenNotice', () => {
  it("takes the licence and holders from the nearest POM that names them, the parent's when the library's does not", () => {
    const parent = '<project><organization><name>Google LLC</name></organization><licenses><license><name>Apache-2.0</name></license></licenses></project>';
    const own = '<project><name>Core</name><url>https://github.com/zxing/zxing</url></project>';
    expect(mavenNotice({ group: 'com.google.zxing', name: 'core', version: '3.5.3', poms: [own, parent] })).toEqual({
      name: 'com.google.zxing:core',
      version: '3.5.3',
      license: 'Apache-2.0',
      licenseUrls: [],
      copyright: ['Copyright Google LLC'],
      homepage: 'https://github.com/zxing/zxing',
      title: 'Core',
    });
  });

  it('names several licences as alternatives', () => {
    const pom = '<project><licenses><license><name>MIT</name></license><license><name>Apache 2</name></license></licenses></project>';
    expect(mavenNotice({ group: 'g', name: 'a', version: '1', poms: [pom] }).license).toBe('(MIT OR Apache-2.0)');
  });
});

describe('buildNotices', () => {
  it('sorts packages, stores each licence text once and gives Android libraries the standard text of their licence', () => {
    const mit = 'MIT text';
    const notices = buildNotices({
      version: '0.8.0',
      js: [
        { name: 'zod', version: '3.0.0', license: 'MIT', copyright: [], homepage: '', texts: [{ file: 'LICENSE', text: mit }] },
        { name: 'buffer', version: '6.0.3', license: 'MIT', copyright: ['Copyright Feross'], homepage: 'https://x', texts: [{ file: 'LICENSE', text: mit }] },
      ],
      android: [{ name: 'androidx.core:core', version: '1.16.0', license: 'Apache-2.0', copyright: [], homepage: '', licenseUrls: ['https://www.apache.org/licenses/LICENSE-2.0.txt'], title: 'Core' }],
      standardTexts: { 'Apache-2.0': 'Apache text' },
    });
    expect(notices.texts).toEqual([mit, 'Apache text']);
    expect(notices.sections.map((s) => [s.id, s.packages.map((p) => [p.name, p.texts])])).toEqual([
      ['js', [['buffer', [0]], ['zod', [0]]]],
      ['android', [['androidx.core:core', [1]]]],
    ]);
    expect(notices.sections[1]!.packages[0]!.homepage).toBe('https://www.apache.org/licenses/LICENSE-2.0.txt');
    expect(isNotices(notices)).toBe(true);
  });
});

describe('filterNotices', () => {
  const notices: Notices = {
    version: '0.8.0',
    texts: [],
    sections: [
      { id: 'js', packages: [{ name: '@duckduckgo/autoconsent', version: '16.58.0', license: 'MPL-2.0', copyright: [], homepage: '', texts: [] }, { name: 'react', version: '19.3.0', license: 'MIT', copyright: ['Copyright (c) Meta Platforms, Inc.'], homepage: '', texts: [] }] },
      { id: 'android', packages: [{ name: 'com.google.zxing:core', version: '3.5.3', license: 'Apache-2.0', copyright: ['Copyright Google LLC'], homepage: '', texts: [] }] },
    ],
  };

  it('keeps everything for an empty query', () => {
    expect(noticeCount(filterNotices(notices, '  '))).toBe(3);
  });

  it('matches every word in the name, licence or copyright, ignoring case, and drops empty sections', () => {
    expect(filterNotices(notices, 'mpl').map((s) => s.packages.map((p) => p.name))).toEqual([['@duckduckgo/autoconsent']]);
    expect(filterNotices(notices, 'META mit').map((s) => s.packages.map((p) => p.name))).toEqual([['react']]);
    expect(filterNotices(notices, 'zxing').map((s) => s.id)).toEqual(['android']);
    expect(filterNotices(notices, 'nothing')).toEqual([]);
  });

  it('refuses a file that is not a notices file', () => {
    expect(isNotices({ version: '1' })).toBe(false);
    expect(isNotices(null)).toBe(false);
  });
});

describe('sourcesOfMap', () => {
  it('reads flat and indexed (sectioned) source maps', () => {
    expect(sourcesOfMap({ sources: ['a.js'] })).toEqual(['a.js']);
    expect(sourcesOfMap({ sections: [{ map: { sources: ['a.js'] } }, { map: { sections: [{ map: { sources: ['b.js'] } }] } }] })).toEqual(['a.js', 'b.js']);
    expect(sourcesOfMap(null)).toEqual([]);
  });
});

describe('buildNotices without licence files', () => {
  it('gives a package without its own licence file the standard text of each licence it names', () => {
    const notices = buildNotices({
      version: '0.8.0',
      js: [{ name: '@react-native/js-polyfills', version: '0.88.0', license: '(MIT OR Apache-2.0)', copyright: [], homepage: '', texts: [] }],
      android: [{ name: 'g:custom', version: '1', license: 'Custom', copyright: [], homepage: '', licenseUrls: ['https://x/license'], title: '' }],
      standardTexts: { MIT: 'MIT text', 'Apache-2.0': 'Apache text' },
    });
    expect(notices.sections.map((s) => s.packages[0]!.texts.map((i) => notices.texts[i]))).toEqual([['MIT text', 'Apache text'], []]);
  });
});

describe('reflowLicense', () => {
  it('joins the wrapped lines of each paragraph and keeps paragraphs and list items apart', () => {
    const text = '                                 Apache License\n                           Version 2.0, January 2004\n\n\n   1. Definitions.\n\n      "License" shall mean the terms\n      and conditions.\r\n\n      (a) You must give\n          a copy;\n      (b) You must cause\n';
    expect(reflowLicense(text)).toBe('Apache License Version 2.0, January 2004\n\n1. Definitions.\n\n"License" shall mean the terms and conditions.\n\n(a) You must give a copy;\n(b) You must cause');
  });
});
