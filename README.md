<div align="center">
  <h1>cloudssh</h1>
  <p>codex cloud workspaces over ssh.</p>
  <p>
    <a href="https://github.com/Microck/cloudssh"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/node-22%2B.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=dark"><img src="https://shieldcn.dev/badge/node-22%2B.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=light" alt="node 22+"></picture></a>
    <a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/license/Microck/cloudssh.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=dark"><img src="https://shieldcn.dev/github/license/Microck/cloudssh.svg?variant=secondary&amp;size=xs&amp;logo=false&amp;mode=light" alt="license"></picture></a>
  </p>
</div>

---

`cloudssh` gives you disposable codex cloud vms as normal ssh workspaces. use it
as a [sandbox sdk](https://github.com/opencoredev/sandbox-sdk) provider, or
register it as a [raft](https://github.com/Microck/raft) location. it drives the
[workssh helper](https://github.com/Microck/workssh-relay) and never buys
credits or touches your existing environments.

[usage](docs/usage.md) | [contract](docs/contract.md) | [workssh setup](https://github.com/Microck/workssh-relay/blob/main/docs/codex-cloud.md)

## quickstart

needs node.js 22+, openssh, an installed workssh helper, your codex login and
cloudflare credentials.

```sh
git clone https://github.com/Microck/cloudssh.git
cd cloudssh
npm ci
npm run build
```

### sandbox sdk

```js
import { createSandbox } from '@opencoredev/sandbox-sdk';
import { cloudssh } from './dist/index.js';

const provider = cloudssh({
  helperRoot: '/path/to/workssh-relay',
  stateDirectory: '/private/path/to/cloudssh-state',
});

const box = await createSandbox(provider, { timeoutMs: 8 * 60 * 60 * 1000 });
try {
  console.log((await box.run('uname -a')).stdout);
} finally {
  await box.destroy();
}
```

### raft

after `plugin add`, set the provider options on the `cloudssh` location (see
[usage](docs/usage.md#register-with-raft)).

```sh
raft plugin add cloudssh -- node /path/to/cloudssh/dist/raft.js
box=$(raft new --location cloudssh --disposable --ttl 28800)
raft ssh "$box"
raft destroy "$box"
```

the ttl bounds ssh access, **not the vm or billing**. always destroy boxes when
you are done. options, keepalive, limits and failure behavior are in
[docs/usage.md](docs/usage.md).

## license

[MIT](LICENSE)
