# Security posture

Read this before granting a component filesystem, network, or process
access. This page covers WASI provider authority and translated-artifact
trust; it is not a security certification of the engine or its dependencies.

## The headline

**The path and request checks in `@polyengine/wasi` are correctness
mechanisms, not a sandbox for hostile guests.** They reject invalid or
out-of-scope requests, but do not replace an OS- or runtime-level boundary.
If a guest is untrusted, or untrusted input controls its paths or network
destinations, the embedder must constrain the host process independently.

Wasm memory isolation does not limit authority deliberately supplied
through host imports. Custom providers and injected transports are trusted
host code; their access and policy are the embedder's responsibility.

## What the implementation gives you

The default `wasi()` merge provides captured CLI I/O, clocks, entropy, and
empty filesystem preopens. Host authority is opt-in through
`filesystem-node`, `filesystem-web`, `sockets`, `http`, and `cli-stdio`.

**Explicit filesystem grants, read-only by default.** There is no ambient
host filesystem. Preopens name the directories exposed to the guest:

```ts
filesystemNode({ preopens: { "/": "./sandbox" } })
```

Write access is a single option for the whole provider, not a per-preopen
permission:

```ts
filesystemNode({ preopens: { "/": "./data" }, writable: true })
```

Without `writable`, mutations are refused with the WIT `read-only` error:
writes, creation, truncation, deletion, rename, link and symlink creation,
and timestamp changes. A single flag avoids mixed read/write grants on
two-descriptor operations such as `link-at` and `rename-at`. It does not
remove the confinement limits below.

**Name-level HTTP policy.** `http()` accepts `allowRequest`, evaluated on
the assembled request before dispatch:

```ts
http({
  allowRequest: ({ url, method }) =>
    url.protocol === "https:" && url.hostname === "api.example.com" &&
    method === "GET",
})
```

The default `true` allows unscoped egress; `false` denies requests while
leaving the types and resources usable. A predicate may be asynchronous.
Returning false or throwing denies with the WIT `HTTP-request-denied`
error; a denied request does not drain the guest's body stream.

The default transport uses `redirect: "manual"`. It does not silently
follow a redirect past the check: a follow-up request must re-enter the
provider and be checked again. An injected `http({ fetch })` transport is
trusted and can undo this property by following redirects itself.

## Why path confinement can never be a boundary

This provider's path checks are not sufficient as a hostile-guest
boundary. The provider resolves paths relative to preopens, refuses
absolute paths and NUL, and prevents `..` from climbing past a preopen.
The node backend also resolves physical paths and checks that they remain
under the preopen's real path before making OS calls.

These checks leave several limits:

- **Hardlinks:** a name inside a preopen can refer to an inode also named
  outside it. Path containment does not establish data provenance.
- **Bind mounts and mount points:** an in-tree path can expose another
  filesystem or host subtree.
- **Cross-process races:** another process can replace a path component
  between resolution and the OS operation. Avoiding that check/use race
  requires descriptor-relative operations such as `openat` with suitable
  resolution constraints; `node:fs` does not expose the needed interface.
- **Backend/platform behavior:** symlink and path handling differ across
  runtimes and permission configurations. The backend contains explicit
  workarounds in [filesystem_node.ts](../wasi/src/filesystem_node.ts), but
  those checks are not an independent isolation layer.

The OPFS backend has no host path namespace or symlinks. Its boundary is
the browser's origin sandbox, not a path check. That does not isolate a
guest from other data the embedder exposes within the same origin.

## What it does not give you

- **No socket policy.** `sockets()` grants the process's network reach,
  including TCP/UDP client and listener operations. There is no address
  allowlist or protocol toggle. Loopback, link-local services, and cloud
  metadata endpoints may be reachable. Tracked in
  [#200](https://github.com/polymorph-components/polyengine/issues/200).
- **No HTTP address policy.** `allowRequest` sees the URL, not the resolved
  address. An allowed name can resolve to a private, loopback, or metadata
  address, and resolution can change before connection. A fetch-based
  provider cannot pin the connection to an address it checked; browsers
  do not expose that control to JS. Name allowlisting alone is not an
  address-level egress boundary.
- **No default process-data isolation with `cliStdio()`.** It exposes the
  process's stdin/stdout/stderr, environment, arguments, and working
  directory by default. Sources and sinks can be overridden. Exit throws
  by default, but `exitProcess: true` permits process termination.
- **No hostile-path isolation from preopen checks alone.** Read-only
  prevents provider-mediated mutation; it does not prevent disclosure
  through an unsafe preopen or the path mechanisms above.
- **No guest preemption.** Cooperative task scheduling does not interrupt
  a guest that keeps executing. Do not treat Promise timeouts as CPU or
  memory quotas; isolate and limit the execution environment as needed.

## Imposing a real boundary

Choose and test deployment controls for the threat model. The WASI
package does not configure them.

**Scoped runtime permissions** reduce process authority. For example:

```sh
# Deno: adjust readable paths for the application and its assets too.
deno run --allow-read=/srv/app,/srv/sandbox --allow-write=/srv/sandbox /srv/app/app.ts

# Node: filesystem permissions, not a network sandbox.
node --permission --allow-fs-read=/srv/app --allow-fs-read=/srv/sandbox --allow-fs-write=/srv/sandbox /srv/app/app.js
```

These apply to the host application as well as guest-triggered operations;
they do not distinguish two callers within one process. Keep unrelated
permissions disabled and review each runtime's limitations. In particular,
[Node's permission model](https://nodejs.org/api/permissions.html) explicitly
does not guarantee protection against malicious code. Network controls
depend on the runtime version; filesystem grants are not a destination
allowlist. Follow the deployed version's permission documentation rather
than assuming the filesystem example establishes network isolation.

**Kernel and process isolation.** Landlock can irreversibly reduce Linux
filesystem authority without privilege. Its protection depends on the
available ABI, handled rights, filesystem topology, inherited descriptors,
and which threads are restricted. It is not a blanket guarantee that any
directory allowlist rejects every hardlink or mount exposure. Follow the
[kernel documentation](https://docs.kernel.org/userspace-api/landlock.html)
and apply the policy before exposing authority to untrusted execution.

Containers or VMs, with appropriately configured filesystem and network
access, can isolate the whole host process. Seccomp can further restrict
system calls but is not by itself a filesystem-path or network-destination
policy. Include resource limits and inherited handles in the deployment
review; merely selecting an isolation technology does not configure it.

**No host namespace.** If the guest does not need live host files, use an
isolated in-memory filesystem or controlled image instead. OPFS similarly
avoids the host namespace, under the browser's origin boundary.

## The artifact cache is a trust input

The [artifact cache](../runtime/src/cache/) stores translated plans and
adapter modules to skip translation on reload
([architecture §10](architecture.md#10-caching)). It is host-side, not a
WASI interface. A filesystem cache can nevertheless share a host namespace
with guest preopens. **Treat cache contents and shipped translation
envelopes as trusted executable inputs.**

The cache and instantiation pipeline check different properties:

- Bundled cache backends check stored metadata against the requested key
  and recorded component hash.
- `loadPlan` checks the plan's structure and format version.
- `verifyComponent` checks the caller's component bytes against the plan's
  recorded length and SHA-256.
- Generated facades check the expected world digest against the plan's
  type information.

None proves that the supplied plan and adapters are what the translator
would produce from those bytes. The digest is derived from the plan, so
it detects binding skew, not authenticity. A custom `ArtifactCache` is
also trusted to honor its interface; `translateCached` does not independently
authenticate its results. Cache write access can substitute executable
artifacts without changing the original component file.

**Keep the cache separate from all preopens.** Do not expose its root, an
ancestor, or an alias through the guest filesystem. Separation alone is
not a hostile-guest boundary: process permissions cannot distinguish a
legitimate host cache write from a guest-induced write by the same
process. The provider's read-only default prevents mutation through that
provider, not through other grants or a compromised host.

**Prefer a pre-warmed, read-only cache for fixed deployments.** Translate
in a trusted build step and deny the production process write access to
the cache and application artifacts. **Verify actual hits after warming:**
the current `dirCache.put` does not create the nested directory required
by normal `adapters/<index>.wasm` names. Those adapter-bearing writes fail,
but `translateCached` still returns a successful fresh translation.
Adapter-free writes are unaffected by this limitation, and correctly
laid-out entries can still be read. Check `fromCache: true` before relying
on prewarming; this documentation does not resolve the backend limitation.

The intended permission split is:

```sh
# Build step: writes trusted cache artifacts.
deno run --allow-read --allow-write=/srv/cache warm.ts

# Production: cache and application are readable, only state is writable.
deno run --allow-read=/srv/app,/srv/cache --allow-write=/srv/state /srv/app/app.ts
```

Hits work without write access. A miss, stale layout, or unreadable root
falls back to fresh translation, which still requires a translator and
valid component bytes. Cache `get`/`put` failures do not fail an otherwise
valid translation. `onCacheError` reports failures caught by
`translateCached`; backend failures converted directly to misses may be
silent. Explicit `evict()` calls can still throw.

A read-only cache prevents persistence through that cache; it does not
prevent persistence through other writable state or replace host isolation.
Build-time envelopes deployed without a translator are another option,
but must be protected as trusted artifacts rather than treated as a cache
that can repair itself.

**On Deno servers, prefer `dirCache` to `webCache`.** Deno's Cache API has
no permission flag and, without `--location`, uses a user-global bucket
that other Deno programs under that user can modify. It is not constrained
by filesystem permission flags. `dirCache` allows an explicit filesystem
policy. It requires Deno; other server runtimes can supply their own
`ArtifactCache`. `webCache` is intended for browsers, where storage is
partitioned by origin, not by component or runtime instance. Same-origin
code is part of that trust boundary.

## Reporting

Report security issues through the
[repository tracker](https://github.com/polymorph-components/polyengine/issues),
or privately to the maintainers when public reproduction details would
enable an escape before a fix is available.
