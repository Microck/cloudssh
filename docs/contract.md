# WorkSSH provider contract

This package implements the published @opencoredev/sandbox-sdk 1.0.3 Provider interface and merged Raft executable plugin protocol 1, inspected at 954b5ae499324144f35362c589d2264f872e617a.

## Ownership and provisioning

The installed Microck/workssh-relay cloud helper owns provisioning. The provider invokes its existing CLI, never copies its provisioner or modifies that checkout. Every provider sandbox has a private controller directory, a journal, one dedicated helper session, one VM, a key and labels. Credentials remain in the helper's existing auth stores or inherited environment. JSON state is validated and atomically replaced with mode 0600 inside mode 0700 directories. Failed or uncertain creation retains its ID and journal for explicit cleanup, never retries a mutation or allocates a replacement.

Create rejects unsupported resizing, non-all networking policy, ports, snapshots and idle expiry before allocation. It defaults to GPT-6 Luna at normal speed, with no model fallback. Credit use requires allowCredits=true. Existing-credit authorization for development tests does not grant the package standing spending consent.

## Lifecycle limits

Only disposable cloud sessions are supported. Create timeoutMs defaults to 600000 and accepts integer milliseconds from 60000 through 2592000000, matching Raft's 30-day bound. This is a caller-authorized access window, not a provider uptime, VM deletion or billing guarantee. Creation and the helper share the exact absolute deadline, including provisioning time. The platform can reclaim the VM earlier. No controller timer guarantees remote VM deletion after the caller exits. Explicit destroy invokes helper down, which must confirm owned resource deletion and offline runtime. close detaches SSH, not the cloud VM. There is no pause, snapshot, terminal resize, preview or size capability. Key lookup is best-effort within one controller state directory. It does not promise cross-controller uniqueness.

Expired access is not a missing sandbox and never authorizes replacement. Explicit provider.reconnect(id, { timeoutMs, signal }) or raft resume BOX --ttl SECONDS requests another bounded SSH agent on the same runtime with the same host pin. It requires normal task approval and allowance checks. It does not restart the VM, change its creation identity or labels, or renew access during exec. A still-running agent keeps its existing deadline; the adapter records the actual confirmed deadline, not the requested one. Failed or uncertain recovery leaves the prior access deadline unchanged and never retries a mutation. Busy leases and deleted or partially deleted sessions block recovery.

## Exec and files

A pinned, public-key-authenticated SSH connection multiplexes independent exec/control channels. A private cross-process lease prevents a second provider process taking over the relay's single client slot. Busy and stale leases fail explicitly; they are never silently stolen.

Guest exec uses a fixed Python supervisor with one new process group per command. Command, environment and stdin travel in stdin JSON, never shell-concatenated secret values. Streams arrive live and stdin is closed after its supplied payload. Timeout and abort kill the whole guest group and confirm termination before a result settles. Loss of transport reports uncertainty, not a falsely confirmed cancellation. Files use binary-safe transfers, preserve lstat types, and write atomically with optional POSIX mode.

Interactive Raft SSH uses the same independent host pin and public-key identity, forwards terminal input/output, restores the local terminal on every exit, and releases its client lease. The upstream SSH server acknowledges resize requests but does not apply them; remote terminal resizing is not guaranteed.

Detached Raft jobs have private guest supervisors and process groups independent of the connection. They close stdin, preserve literal argv, retain at most the first 1 MiB of combined output with a dropped-byte counter, and cannot outlive the declared sandbox lifetime. Cancellation confirms owned child-group termination. Status/logs refresh and cache private controller records; explicit destruction collects/cancels jobs before revoking the VM. Cached terminal results remain available for seven days after completion, including after explicit destruction. Unexpected platform reclaim can lose output not yet retrieved; an unconfirmed outcome is interrupted or an error, never fabricated completion.

Recursive transfers publish a complete new directory with an existing parent and never merge or overwrite destinations, including symlinks. They preserve files, executable modes, empty directories, internal hardlinks and safe relative symlinks. Traversal, escaping links, special files and unsupported archive members are rejected before publication. Transfers use bounded chunks rather than loading an arbitrary tree into memory.

## Raft

The executable advertises new, resume, list, info, exec, ssh, upload, download, logs, status, cancel, usage, capacity, doctor, gc and destroy. describe is side-effect-free and requires no credentials. Literal argv is POSIX-quoted once, stdout carries normal results and guest output, stderr carries diagnostics, and guest exit codes are preserved. All box operations check SDK and Raft location labels before connection or mutation. Unsupported options fail before allocating anything. Global raft --json is owned by Raft, not nested by the plugin. Cancellation is bounded locally and preserves unknown remote outcomes for inspection; it never claims cloud deletion without confirmation.

Capacity reports no configured local VM-count limit and unknown provider total, remaining slots and quota, never infinity or a guessed eight-VM cap. Usage and info measure the connected guest's actual cgroup CPU/memory and filesystem counters. List and doctor probe live health for available ready sessions; recorded readiness is distinguished from live reachability. gc explicitly destroys only expired sessions owned by the selected Raft location; no offline-controller deletion guarantee is implied. Raft resume restores bounded SSH access only, not a paused VM or process memory. Persistent boxes, snapshots, resizing and forwarding remain unsupported.

## Verification

Permanent tests use the actual published SDK and actual SSH/guest subprocesses under disposable state, not module mocks. Cloud provisioning and the helper's API behavior require separately authorized live testing. Local fixture coverage cannot prove cloud uptime, quota exemption, or provider-side hard expiry.
