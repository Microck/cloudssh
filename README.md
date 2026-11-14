# WorkSSH for Sandbox SDK and Raft

Use disposable Codex Cloud VMs through WorkSSH with [`@opencoredev/sandbox-sdk`](https://github.com/opencoredev/sandbox-sdk), or register the same provider as a [Raft executable plugin](https://github.com/Microck/raft/blob/main/docs/guides/plugins.mdx).

This package drives the installed [WorkSSH cloud helper](https://github.com/Microck/workssh-relay). It does not copy its provisioner, change your existing environments, bypass platform restrictions, or install a provider inside Raft.

## Requirements

- Node.js 22+, OpenSSH, `ssh-keygen`, and Linux with Python 3.11.8+ and Bash. Recursive transfers also need Python on the controller.
- An installed WorkSSH helper checkout, with both `tunnel` and `relay` locked dependencies installed. Follow its [cloud setup guide](https://github.com/Microck/workssh-relay/blob/main/docs/codex-cloud.md).
- Your existing Codex OAuth login and Cloudflare deployment credentials. No credentials belong in source, plugin command arguments, or shared configuration.
- Permission to consume Codex allowance and Cloudflare resources. The package never purchases credits or changes subscriptions. `allowCredits` defaults to false.
- For the Raft entry point, a Raft version containing merged executable plugin protocol 1. Raft 0.7 and 0.8 do not contain it; use a release with `raft plugin` or a pinned merged-source installation.

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
  timeoutMs: 8 * 60 * 60 * 1000, // Explicit eight-hour access window, including setup.
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

`close()` detaches SSH but leaves the cloud resources allocated. Within the access window, pass the saved ID to `connectSandbox(provider, id)`. After SSH access expires, explicitly request another bounded window with `await provider.reconnect(id, { timeoutMs: 8 * 60 * 60 * 1000 })`, then connect using the same ID. This checks the original runtime and host pin; it never allocates a replacement. It can consume model allowance and requires normal command approval. Use `destroy()` when finished. Do not rely on garbage collection or process exit to delete a VM.

The provider implements create, key lookup, reconnect, filtered list, exec, files, close, and destroy. SDK commands preserve their environment and stdin, stream text output, and terminate the remote process group on timeout or abort. Binary file reads and writes do not pass through text decoding. Optional POSIX file modes are supported.

Individual SDK/file transfers are limited to 32 MiB. Recursive Raft transfers use bounded archive chunks and do not have that total-tree limit.

Size selection, restrictive networking, VM pause/resume, snapshots and previews remain unsupported. The SDK's persistent-process API is not advertised; Raft detached jobs have their own bounded supervisor and retained records. `network: 'all'` is accepted; explicit ports and idle expiry are rejected before allocation.

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
raft plugin add openai -- node /absolute/path/to/sandbox-sdk-workssh/dist/raft.js
```

Set that location's `options` in `~/.config/raft/incus.json`. Preserve all other locations:

```json
{
  "openai": {
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
box=$(raft new --location openai --disposable --ttl 28800 \
  --purpose 'Compiler check' --owner 'Local operator' --next 'Destroy after verification')
raft list --location openai
raft info "$box"
raft exec "$box" -- printf '%s\n' 'literal $argument'
raft upload "$box" ./input.txt /workspace/input.txt
raft download "$box" /workspace/input.txt ./output.txt
raft destroy "$box"
```

The plugin supports `new`, `resume`, `list`, `info`, `ssh`, `exec`, `upload`, `download`, `logs`, `status`, `cancel`, `usage`, `capacity`, `doctor`, `gc`, and `destroy`. Notes are stored as labels. Every operation checks SDK and Raft location ownership before connecting or deleting. Removing registration does not remove its cloud resources.

`raft ssh "$box"` opens a real interactive shell and restores the controller terminal when it exits. The upstream SSH server does not apply terminal resize requests, so remote resizing is not guaranteed. Foreground `exec` accepts UTF-8 stdin up to 16 MiB; shell input and output are terminal byte streams.

```sh
raft capacity --location openai --json
raft doctor --location openai
raft usage "$box"
raft ssh "$box"
job=$(raft exec --detach "$box" -- bash -lc 'make check')
raft status "$box" "$job"
raft logs "$box" "$job"
raft cancel "$box" "$job"
raft upload "$box" ./project /workspace/project --recursive
raft download "$box" /workspace/project ./project-copy --recursive
raft gc --location openai
```

Capacity reports no configured local VM-count limit and unknown provider capacity, remaining slots and quota. It never reports infinity or an eight-VM maximum. `usage` and `info` measure actual guest CPU/memory/filesystem counters. `list` and `doctor` probe available sessions; an unreachable, busy or expired session has unknown live state rather than a fabricated running/stopped result.

Detached jobs close stdin, survive SSH disconnection, and terminate by the shorter of their command deadline and the sandbox's declared lifetime. They retain the first 1 MiB of combined output and report dropped bytes. Querying status/logs caches results privately on the controller. Destruction cancels and collects jobs before revoking the VM, and cached terminal records remain available for seven days. Unexpected platform reclaim can lose output not yet collected; transport failures never imply successful completion. A failed pre-deletion collection is reported even if cloud deletion succeeds.

Recursive transfers require a real source directory, an absent destination and an existing destination parent. They preserve executable modes, empty directories, internal hardlinks and safe relative symlinks. Traversal, escaping links and special files are rejected; a failed transfer leaves no partially published destination. Explicit sizing, persistent stop, snapshots, forwarding and `raft run` are still refused. `raft resume "$box" --ttl 28800` restores bounded SSH access on the same VM; it does not resume a paused VM or restore process memory.

`raft --json` remains Raft's output wrapper. The plugin emits normal bytes rather than nested JSON event envelopes. Missing or unsupported capabilities fail before the action runs.

## Lifetime and failure limits

`timeoutMs` defaults to ten minutes and accepts integer milliseconds from one minute through 30 days, matching Raft's allowed TTL range. Choose the window you intend to work for, such as `--ttl 28800` for eight hours. SDK/Raft and the helper share one exact deadline, including provisioning time. The deadline bounds SSH access, **not VM deletion or billing**. The platform may reclaim the VM earlier; a 30-day local bound is not a 30-day uptime guarantee. Expiry never starts model work or renews access automatically.

After expiry, use `raft resume "$box" --ttl 28800` or `provider.reconnect(id, { timeoutMs: 28_800_000 })`. An active agent is reused without extending its confirmed deadline. Failed, denied or uncertain recovery retains the previous access deadline and never creates a replacement. Explicit destruction is still required. Detached jobs retain their original deadlines even if SSH access is later renewed.

A failed or interrupted create retains an owned ID and journal for inspection and deletion. It never retries an uncertain creation or silently allocates a replacement. Inspect the error's `sandboxId`, the SDK's `listSandboxes`, or `raft list`, then destroy only that session. The SDK's recorded `stopped` state means unavailable for execution, not confirmed VM shutdown; Raft reports the live probe separately.

One provider process owns the relay's client slot while SSH is attached. Its SSH connection can multiplex concurrent commands and cancellation channels. A second process receives a busy-lease error instead of taking over the tunnel. Close the first handle before reconnecting elsewhere. After a crash, inspect the lease PID and confirm that process has ended before removing the reported lease directory; leases are never silently stolen.

Setup uses the helper's normal per-task approval reviewer. A rejected command or network denial remains an error, not a reason to switch identities, proxies, or policies. Model-driven setup can require inspection or guidance. The helper's APIs are unofficial and can change.

Timeout and abort results require confirmed process-group termination. If transport disappears before confirmation, the provider reports an uncertain outcome instead. Cancellation can stop the local helper without proving that a cloud mutation was undone. Inspect retained state before retrying; no local timer guarantees remote cleanup during an outage.

## Development verification

```sh
npm ci
npm run check
# Full CLI acceptance needs the merged Raft command:
RAFT_TEST_CLI=/absolute/path/to/raft npm run test:raft
```

Tests use the published SDK, real SSH connections, guest Python subprocesses, and disposable helper fixtures. They do not mock modules, contact cloud services, or use the operator's normal credentials. Run the full integration workflow in a disposable Linux target; actual Raft CLI integration also needs a protocol-1 Raft checkout. Live cloud checks require separate bounded authorization.

The initial implementation passed 19 tests with SDK 1.0.3 and actual Raft CLI checks. Its separately authorized one-VM cloud check verified environment/stdin, exit status, binary files, output beyond 1 MiB per stream, timeout termination and fresh-process reconnection, followed by confirmed resource cleanup. New host-operation acceptance uses the real SSH server and guest subprocesses in a disposable Linux workspace; it does not allocate an OpenAI VM.

The behavioral contract is in [docs/contract.md](docs/contract.md). Local fixture success does not establish cloud uptime, resource guarantees, quota exemption, or VM-expiry semantics.
