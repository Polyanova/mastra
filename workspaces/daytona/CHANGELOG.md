# @mastra/daytona

## 0.1.0-alpha.0

### Minor Changes

- Add DaytonaSandbox workspace provider — Daytona cloud sandbox integration for Mastra workspaces, implementing the WorkspaceSandbox interface with support for command execution, environment variables, resource configuration, snapshots, and Daytona volumes. ([#13112](https://github.com/mastra-ai/mastra/pull/13112))

  **Basic usage**

  ```ts
  import { Workspace } from '@mastra/core/workspace';
  import { DaytonaSandbox } from '@mastra/daytona';

  const sandbox = new DaytonaSandbox({
    id: 'my-sandbox',
    env: { NODE_ENV: 'production' },
  });

  const workspace = new Workspace({ sandbox });
  await workspace.init();

  const result = await workspace.sandbox.executeCommand('echo', ['Hello!']);
  console.log(result.stdout); // "Hello!"

  await workspace.destroy();
  ```

- Added S3 and GCS cloud filesystem mounting support via FUSE (s3fs-fuse, gcsfuse). Daytona sandboxes can now mount cloud storage as local directories, matching the mount capabilities of E2B and Blaxel providers. ([#13544](https://github.com/mastra-ai/mastra/pull/13544))

  **New methods:**
  - `mount(filesystem, mountPath)` — Mount an S3 or GCS filesystem at a path in the sandbox
  - `unmount(mountPath)` — Unmount a previously mounted filesystem

  **What changed:**
  - Added S3 and GCS bucket mounts as local directories in Daytona sandboxes.
  - Improved reconnect behavior so mounts are restored reliably.
  - Added safety checks to prevent mounting into non-empty directories.
  - Improved concurrent mount support by isolating credentials per mount.

  **Usage:**

  ```typescript
  import { Workspace } from '@mastra/core/workspace';
  import { S3Filesystem } from '@mastra/s3';
  import { DaytonaSandbox } from '@mastra/daytona';

  const workspace = new Workspace({
    mounts: {
      '/data': new S3Filesystem({
        bucket: 'my-bucket',
        region: 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }),
    },
    sandbox: new DaytonaSandbox(),
  });
  ```

### Patch Changes

- Remove internal `processes` field from sandbox provider options ([#13597](https://github.com/mastra-ai/mastra/pull/13597))

  The `processes` field is no longer exposed in constructor options for E2B, Daytona, and Blaxel sandbox providers. This field is managed internally and was not intended to be user-configurable.

- Sandbox instructions no longer include a working directory path, keeping instructions stable across sessions. ([#13520](https://github.com/mastra-ai/mastra/pull/13520))

- Updated dependencies [[`88de7e8`](https://github.com/mastra-ai/mastra/commit/88de7e8dfe4b7e1951a9e441bb33136e705ce24e), [`edee4b3`](https://github.com/mastra-ai/mastra/commit/edee4b37dff0af515fc7cc0e8d71ee39e6a762f0), [`d5f0d8d`](https://github.com/mastra-ai/mastra/commit/d5f0d8d6a03e515ddaa9b5da19b7e44b8357b07b), [`09c3b18`](https://github.com/mastra-ai/mastra/commit/09c3b1802ff14e243a8a8baea327440bc8cc2e32), [`524c0f3`](https://github.com/mastra-ai/mastra/commit/524c0f3c434c3d9d18f66338dcef383d6161b59c), [`3c6ef79`](https://github.com/mastra-ai/mastra/commit/3c6ef798481e00d6d22563be2de98818fd4dd5e0), [`9311c17`](https://github.com/mastra-ai/mastra/commit/9311c17d7a0640d9c4da2e71b814dc67c57c6369), [`d25b9ea`](https://github.com/mastra-ai/mastra/commit/d25b9eabd400167255a97b690ffbc4ee4097ded5), [`b03c0e0`](https://github.com/mastra-ai/mastra/commit/b03c0e0389a799523929a458b0509c9e4244d562), [`9257d01`](https://github.com/mastra-ai/mastra/commit/9257d01d1366d81f84c582fe02b5e200cf9621f4), [`191e5bd`](https://github.com/mastra-ai/mastra/commit/191e5bd29b82f5bda35243945790da7bc7b695c2), [`257d14f`](https://github.com/mastra-ai/mastra/commit/257d14faca5931f2e4186fc165b6f0b1f915deee), [`31c78b3`](https://github.com/mastra-ai/mastra/commit/31c78b3eb28f58a8017f1dcc795c33214d87feac), [`3c6ef79`](https://github.com/mastra-ai/mastra/commit/3c6ef798481e00d6d22563be2de98818fd4dd5e0), [`9257d01`](https://github.com/mastra-ai/mastra/commit/9257d01d1366d81f84c582fe02b5e200cf9621f4)]:
  - @mastra/core@1.9.0-alpha.0
