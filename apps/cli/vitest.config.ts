import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/cli',
      'packages/core',
      'packages/vscode-ide-companion',
      'packages/sdk-typescript',
      'packages/channels/base',
      'packages/channels/dingtalk',
      'packages/channels/telegram',
      'packages/channels/weixin',
      'packages/channels/qqbot',
      // 'integration-tests' was listed here and the directory does not exist in
      // this fork, which made `vitest run` at this root fail before collecting a
      // single test ("Projects definition references a non-existing file or a
      // directory"). Every test in the repo was therefore only reachable by
      // running vitest from inside a package. PLAN 7.2.
      'scripts',
    ],
  },
});
