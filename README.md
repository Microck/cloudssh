# WorkSSH for Sandbox SDK and Raft

Use disposable Codex Cloud VMs through WorkSSH with [`@opencoredev/sandbox-sdk`](https://github.com/opencoredev/sandbox-sdk), or register the same provider as a [Raft executable plugin](https://github.com/Microck/raft/pull/28).

This package drives the installed [WorkSSH cloud helper](https://github.com/Microck/workssh-relay). It does not copy its provisioner, change your existing environments, bypass platform restrictions, or install a provider inside Raft.

## Requirements

- Node.js 22+, OpenSSH, `ssh-keygen`, and a Linux guest with Python 3 and Bash.
- An installed WorkSSH helper checkout, with both `tunnel` and `relay` locked dependencies installed. Follow its [cloud setup guide](https://github.com/Microck/workssh-relay/blob/main/docs/codex-cloud.md).
- Your existing Codex OAuth login and Cloudflare deployment credentials. No credentials belong in source, plugin command arguments, or shared configuration.
- Permission to consume Codex allowance and Cloudflare resources. The package never purchases credits or changes subscriptions. `allowCredits` defaults to false.
- For the Raft entry point, a Raft version containing PR #28's executable plugin protocol 1. Earlier Raft versions do not support `raft plugin`.

```sh
git clone https://github.com/Microck/sandbox-sdk-workssh.git
cd sandbox-sdk-workssh
npm ci
npm run build
```

The package is available from this repository. These instructions do not assume an npm publication.

## Use Sandbox SDK

```js
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, connectSandbox } from '@opencoredev/sandbox-sdk';
import { workssh } from './dist/index.js';

const provider = workssh({
  helperRoot: join(homedir(), 'src/workssh-relay'),
  stateDirectory: join(homedir(), '.local/state/sandbox-sdk-workssh'),
  cloudflareEnv: join(homedir(), '.config/cloudflare/global.env'),
  // Set allowCredits: true only when you consent to using existing Codex credits.
});

const box = await createSandbox(provider, {
  key: 'build-scratch',
  labels: { project: 'compiler-check' },
  timeoutMs: 600_000,
  env: { BUILD_MODE: 'check' },
});

try {
  await box.files.write('/workspace/input.txt', 'owned disposable workspace\n');
  const result = await box.run('cat /workspace/input.txt');
  console.log(result.stdout);
  // Save box.id if you want to reconnect from another process.
} finally {
  await box.destroy();
}
```

`close()` detaches SSH but leaves the cloud resources allocated. To reconnect, pass the saved ID to `connectSandbox(provider, id)`. Use `destroy()` when finished. Do not rely on garbage collection or process exit to delete a VM.

The provider implements create, key lookup, reconnect, filtered list, exec, files, close, and destroy. SDK commands preserve their environment and stdin, stream text output, and terminate the remote process group on timeout or abort. Binary file reads and writes do not pass through text decoding. Optional POSIX file modes are supported.

Each file transfer is limited to 32 MiB. Larger files fail explicitly; use guest commands or split files within that bound.

There are no size, network-policy, pause, snapshot, terminal-resize, or preview capabilities. Persistent background-process APIs are unsupported because every exec owns a bounded process group. Unsupported creation options fail before allocation. `network: 'all'` is accepted; restrictive network policies, explicit ports, snapshots, and idle expiry are not.

### Provider options

| Option | Behavior |
| --- | --- |
| `helperRoot` | Required absolute path to the installed WorkSSH helper checkout. |
| `stateDirectory` | Required absolute private controller registry directory. Keep it out of repositories and backups you share. |
| `authFile` | Optional absolute Codex OAuth file path. The helper default is `~/.codex/auth.json`. |
| `cloudflareEnv` | Optional absolute private Cloudflare credential-file path. Existing environment credentials also work. |
| `accountId` | Optional Cloudflare account selection. |
| `model` | Setup model, default `gpt-6-luna`. No silent model fallback. |
| `allowCredits` | Explicit consent to existing Codex credits when included allowance is exhausted. Default false. |
| `operationTimeoutMs` | Helper/plugin invocation deadline, default 600000 ms. |

Controller state includes per-sandbox SSH credentials, labels, and the creation environment. Directories are private and files are mode 0600. Registered SDK secrets still follow the SDK's output-redaction behavior; controller state itself must remain private.

## Register with Raft

Register the compiled entry point:

```sh
raft plugin add work -- node /absolute/path/to/sandbox-sdk-workssh/dist/raft.js
```

Set that location's `options` in `~/.config/raft/incus.json`. Preserve all other locations:

```json
{
  "work": {
    "plugin": ["/absolute/path/to/node", "/absolute/path/to/sandbox-sdk-workssh/dist/raft.js"],
    "options": {
      "helperRoot": "/absolute/path/to/workssh-relay",
      "stateDirectory": "/absolute/private/path/to/workssh-sandboxes",
      "cloudflareEnv": "/absolute/private/path/to/cloudflare.env"
    },
    "note": "Disposable Codex Cloud VMs. Provider charges apply."
  }
}
```

Registration's `describe` handshake does not require credentials or allocate a sandbox. Normal actions require valid options. The package never edits your normal Raft configuration itself.

```sh
box=$(raft new --location work --disposable --ttl 600 \
  --purpose 'Compiler check' --owner 'Local operator' --next 'Destroy after verification')
raft list --location work
raft info "$box"
raft exec "$box" -- printf '%s\n' 'literal $argument'
raft upload "$box" ./input.txt /workspace/input.txt
raft download "$box" /workspace/input.txt ./output.txt
raft destroy "$box"
```

The plugin advertises only `new`, `list`, `info`, `exec`, `upload`, `download`, and `destroy`. Creation notes are stored as labels and returned in Raft's note template. Every operation checks the SDK and Raft location labels before connecting or deleting. Removing a plugin registration does not remove its cloud resources.

Explicit sizing, snapshots, persistent stop/resume, `raft run`, recursive Raft transfers, and detached exec are refused. SDK file helpers remain available through the direct provider. Raft exec accepts UTF-8 text stdin up to 16 MiB, closes it before execution, and streams text output. It is not an interactive terminal or a binary stdio transport. Single-file upload/download preserves binary bytes; a failed download leaves an existing destination unchanged.

`raft --json` remains Raft's output wrapper. The plugin emits normal bytes rather than nested JSON event envelopes. Missing or unsupported capabilities fail before the action runs.

## Lifetime and failure limits

`timeoutMs` defaults to ten minutes and accepts one minute to two hours. It bounds the WorkSSH agent, rounded up to whole minutes, **not VM deletion or billing**. Provisioning uses part of that lifetime. The platform may reclaim the VM earlier. After the declared lifetime, the provider refuses further guest operations; explicit destruction is still required.

A failed or interrupted create retains an owned ID and journal for inspection and deletion. It never retries an uncertain creation or silently allocates a replacement. Inspect the error's `sandboxId`, the SDK's `listSandboxes`, or `raft list`, then destroy only that session. Incomplete sessions may appear as `stopped`; that means unavailable for SDK execution, not independently confirmed VM shutdown.

One provider process owns the relay's client slot while SSH is attached. Its SSH connection can multiplex concurrent commands and cancellation channels. A second process receives a busy-lease error instead of taking over the tunnel. Close the first handle before reconnecting elsewhere. After a crash, inspect the lease PID and confirm that process has ended before removing the reported lease directory; leases are never silently stolen.

Setup uses the helper's normal per-task approval reviewer. A rejected command or network denial remains an error, not a reason to switch identities, proxies, or policies. Model-driven setup can require inspection or guidance. The helper's APIs are unofficial and can change.

Timeout and abort results require confirmed process-group termination. If transport disappears before confirmation, the provider reports an uncertain outcome instead. Cancellation can stop the local helper without proving that a cloud mutation was undone. Inspect retained state before retrying; no local timer guarantees remote cleanup during an outage.

## Development verification

```sh
npm ci
npm run check
```

Tests use the published SDK, real SSH connections, guest Python subprocesses, and disposable helper fixtures. They do not mock modules, contact cloud services, or use the operator's normal credentials. Run the full integration workflow in a disposable Linux target; actual Raft CLI integration also needs a protocol-1 Raft checkout. Live cloud checks require separate bounded authorization.

Verified with SDK 1.0.3 and Raft PR #28: 19 tests and the actual CLI workflow passed in a disposable Linux workspace. One authorized cloud VM also passed SDK environment/stdin, exit-status, binary-transfer, streaming and timeout checks, followed by fresh-process Raft reconnection. Each output stream exceeded 1 MiB. Destruction confirmed config, vault and relay deletion and the runtime offline.

The behavioral contract is in [docs/contract.md](docs/contract.md). Local fixture success does not establish cloud uptime, resource guarantees, quota exemption, or VM-expiry semantics.
