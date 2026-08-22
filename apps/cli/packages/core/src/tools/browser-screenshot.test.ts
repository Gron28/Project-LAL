import { describe, expect, it } from 'vitest';
import { BrowserScreenshotTool } from './browser-screenshot.js';

function tool(root = '/workspace') {
  return new BrowserScreenshotTool({
    getTargetDir: () => root,
    storage: { getProjectTempDir: () => `${root}/.tmp` },
  } as never);
}

describe('BrowserScreenshotTool', () => {
  it('is always visible and carries explicit browser keywords', () => {
    const instance = tool();
    expect(instance.shouldDefer).toBe(false);
    expect(instance.searchHint).toContain('screenshot');
  });

  it('accepts localhost and workspace file targets', () => {
    expect(() => tool().build({ url: 'http://127.0.0.1:3000' })).not.toThrow();
    expect(() => tool().build({ url: 'http://localhost:3000/page' })).not.toThrow();
    expect(() => tool().build({ url: 'file:///workspace/index.html' })).not.toThrow();
  });

  it('rejects remote browsing and paths outside the workspace', () => {
    expect(() => tool().build({ url: 'https://example.com' })).toThrow(/localhost/);
    expect(() => tool().build({ url: 'file:///etc/passwd' })).toThrow(/workspace/);
    expect(() => tool().build({
      url: 'http://localhost:3000',
      output_file: '/tmp/leak.png',
    })).toThrow(/workspace/);
  });
});
