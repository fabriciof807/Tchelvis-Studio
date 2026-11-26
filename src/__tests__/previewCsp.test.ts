// Node built-ins are available in Vitest's Node runtime, but this project does not
// ship @types/node; suppress the missing-declaration error for this import only.
// @ts-expect-error -- no @types/node dependency
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface TauriConfig {
  app: {
    security: {
      csp: string;
    };
  };
}

// Vitest runs with the repository root as the working directory.
const config = JSON.parse(
  readFileSync('src-tauri/tauri.conf.json', 'utf8'),
) as TauriConfig;

function directivesOf(csp: string): string[] {
  return csp
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0);
}

describe('preview CSP', () => {
  it('allows loopback preview iframes in frame-src', () => {
    const frameSrc = directivesOf(config.app.security.csp).find((directive) =>
      directive.startsWith('frame-src '),
    );

    expect(frameSrc).toBe("frame-src 'self' blob: data: http://127.0.0.1:*");
    expect(frameSrc).not.toContain('localhost');
  });

  it('keeps every other directive unchanged', () => {
    const rest = directivesOf(config.app.security.csp).filter(
      (directive) => !directive.startsWith('frame-src '),
    );

    expect(rest).toEqual([
      "default-src 'self'",
      "img-src 'self' asset: http://asset.localhost data: blob:",
      "connect-src 'self' asset: http://asset.localhost data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
    ]);
  });
});
