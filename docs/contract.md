# WorkSSH provider contract

This package implements the published @opencoredev/sandbox-sdk 1.0.3 Provider interface and Raft executable plugin protocol 1 from Microck/raft PR 28, inspected at 6a88958fe2df00118490357913b0d97d84a9223d.

## Ownership and provisioning

The installed Microck/workssh-relay cloud helper owns provisioning. The provider invokes its existing CLI, never copies its provisioner or modifies that checkout. Every provider sandbox has a private controller directory, a journal, one dedicated helper session, one VM, a key and labels. Credentials remain in the helper's existing auth stores or inherited environment. JSON state is validated and atomically replaced with mode 0600 inside mode 0700 directories. Failed or uncertain creation retains its ID and journal for explicit cleanup, never retries a mutation or allocates a replacement.

Create rejects unsupported resizing, non-all networking policy, ports, snapshots and idle expiry before allocation. It defaults to GPT-6 Luna at normal speed, with no model fallback. Credit use requires allowCredits=true. Existing-credit authorization for development tests does not grant the package standing spending consent.

## Lifecycle limits

Only disposable cloud sessions are supported. Create timeoutMs defaults to 600000 and must be 60000..7200000; it bounds the helper agent, rounded up to whole minutes, not the VM or billing lifetime. The platform can reclaim the VM earlier. No controller timer guarantees remote VM deletion after the caller exits. Explicit destroy invokes helper down, which must confirm owned resource deletion and offline runtime. close detaches SSH, not the cloud VM. There is no pause, snapshot, terminal resize, preview or size capability. Key lookup is best-effort within one controller state directory. It does not promise cross-controller uniqueness.

## Exec and files

A pinned, public-key-authenticated SSH connection multiplexes independent exec/control channels. A private cross-process lease prevents a second provider process taking over the relay's single client slot. Busy and stale leases fail explicitly; they are never silently stolen.

Guest exec uses a fixed Python supervisor with one new process group per command. Command, environment and stdin travel in stdin JSON, never shell-concatenated secret values. Streams arrive live and stdin is closed after its supplied payload. Timeout and abort kill the whole guest group and confirm termination before a result settles. Loss of transport reports uncertainty, not a falsely confirmed cancellation. Files use binary-safe transfers, preserve lstat types, and write atomically with optional POSIX mode.

## Raft

The executable advertises only new, list, info, exec, upload, download and destroy. describe is side-effect-free and requires no credentials. Literal argv is POSIX-quoted once, stdout carries normal results and guest output, stderr carries diagnostics, and guest exit codes are preserved. All box operations check SDK and Raft location labels before connection or mutation. Unsupported options fail before allocating anything. Global raft --json is owned by Raft, not nested by the plugin. Cancellation is bounded locally and preserves unknown remote outcomes for inspection; it never claims cloud deletion without confirmation.

## Verification

Permanent tests use the actual published SDK and actual SSH/guest subprocesses under disposable state, not module mocks. Cloud provisioning and the helper's API behavior require separately authorized live testing. Local fixture coverage cannot prove cloud uptime, quota exemption, or provider-side hard expiry.
