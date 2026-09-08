// Fetches engine shells into `.shell-cache/` (gitignored), caching by build
// identity so re-runs don't re-download.
//
// LANE IDS (versions and digests in tools/shell/pins.json):
//   sm-pinned   — SpiderMonkey release, sha256-verified.
//   sm-nightly  — SpiderMonkey mozilla-central nightly.
//   jsc-pinned  — JSC trunk rev pinned in pins.json,
//                 sha256-verified, mirrored to a repo-owned release (see
//                 fetchJsc's header for why webkitgtk.org can't be pinned).
//   jsc-trunk   — JSC trunk LAST-IS (x86_64 only).
//   node-pinned — Node.js release pinned in pins.json (nodejs.org dist
//                 tarball), sha256-verified; both linux arches.
//   bun-pinned  — Bun release pinned in pins.json (oven-sh/bun GitHub
//                 release zip), sha256-verified; both linux arches.
//
// Usage: deno run -A tools/shell/fetch.ts
//        <sm-pinned|sm-nightly|jsc-pinned|jsc-trunk|node-pinned|bun-pinned>
//
// Zip extraction requires python3 and preserves executable modes and symlinks.

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);
const cacheRoot = join(repoRoot, ".shell-cache");

interface Pins {
  spidermonkey: {
    channel: string;
    version: string;
    urlTemplate: string;
    sha256: Record<string, string>;
  };
  jsc: { rev: string; url: string; sha256: string; arch: string };
  node: { version: string; urlTemplate: string; sha256: Record<string, string> };
  bun: { version: string; urlTemplate: string; sha256: Record<string, string> };
}

let pinsCache: Pins | null = null;
async function loadPins(): Promise<Pins> {
  if (pinsCache) return pinsCache;
  const text = await Deno.readTextFile(join(repoRoot, "tools", "shell", "pins.json"));
  pinsCache = JSON.parse(text) as Pins;
  return pinsCache;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export function defaultShellPaths(
  lane: string,
): { bin: string; libPath: string | null } {
  if (lane === "sm-pinned" || lane === "sm-nightly") {
    const dir = join(cacheRoot, lane);
    return { bin: join(dir, "js"), libPath: dir };
  }
  if (lane === "jsc-pinned" || lane === "jsc-trunk") {
    const dir = join(cacheRoot, lane);
    // `<dir>/jsc` is the bundle's own compiled wrapper (NOT the real
    // binary, which sits at `<dir>/bin/jsc` with a relative PT_INTERP) —
    // see fetchJsc below. No LD_LIBRARY_PATH: the wrapper sets its own,
    // overwriting anything we pass.
    return { bin: join(dir, "jsc"), libPath: null };
  }
  if (lane === "node-pinned") {
    // fetchNodePinned extracts with --strip-components=1, so the tarball's
    // versioned top directory is gone and bin/node is stable across pins.
    return { bin: join(cacheRoot, lane, "bin", "node"), libPath: null };
  }
  if (lane === "bun-pinned") {
    // fetchBunPinned copies the single static binary out of the zip's
    // arch-named subdirectory to a stable path.
    return { bin: join(cacheRoot, lane, "bun"), libPath: null };
  }
  throw new Error(`unknown lane: ${lane}`);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  // extractall() loses executable modes and materializes symlinks as files.
  // Restore both: JSC needs executable launchers and real shared-library links.
  const cmd = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys, os, stat, zipfile\n" +
      "z = zipfile.ZipFile(sys.argv[1])\n" +
      "dest = sys.argv[2]\n" +
      "for i in z.infolist():\n" +
      "    mode = i.external_attr >> 16\n" +
      "    p = os.path.join(dest, i.filename)\n" +
      "    if stat.S_ISLNK(mode):\n" +
      "        os.makedirs(os.path.dirname(p), exist_ok=True)\n" +
      "        if os.path.lexists(p): os.remove(p)\n" +
      "        os.symlink(z.read(i).decode(), p)\n" +
      "        continue\n" +
      "    z.extract(i, dest)\n" +
      "    m = mode & 0o7777\n" +
      "    if m and not i.is_dir(): os.chmod(p, m)\n",
      zipPath,
      destDir,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`python3 zipfile extraction failed (${zipPath})`);
}

function smArch(): string {
  // SpiderMonkey publishes linux-aarch64 and linux-x86_64 shells (both
  // nightly and release channels).
  return Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
}

/**
 * Checks a lane's `BUILD_IDENTITY` file against an expected identity string.
 * A pinned lane's identity is the pin's version/sha — when `pins.json` bumps
 * the version, the on-disk cache's stamp no longer matches and this returns
 * `false`, triggering a refetch without manual cache clearing.
 */
async function cacheMatches(dir: string, expectedIdentity: string): Promise<boolean> {
  try {
    const stamp = await Deno.readTextFile(join(dir, "BUILD_IDENTITY"));
    return stamp.includes(expectedIdentity);
  } catch {
    return false;
  }
}

async function fetchSpiderMonkeyNightly(): Promise<void> {
  const dir = join(cacheRoot, "sm-nightly");
  const binPath = join(dir, "js");
  try {
    await Deno.stat(binPath);
    console.log(`[fetch] sm-nightly already cached at ${binPath}`);
    return;
  } catch {
    // not cached — fetch below
  }
  const arch = smArch();
  const base = "https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central";
  const url = `${base}/jsshell-linux-${arch}.zip`;
  console.log(`[fetch] sm-nightly: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const buildId = res.headers.get("last-modified") ?? "unknown";
  const zipPath = join(cacheRoot, "sm-nightly.zip");
  await Deno.mkdir(cacheRoot, { recursive: true });
  await Deno.writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
  await extractZip(zipPath, dir);
  await Deno.remove(zipPath);
  await Deno.chmod(binPath, 0o755);
  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `jsshell-linux-${arch}.zip\nLast-Modified: ${buildId}\nfetched: ${
      new Date().toISOString()
    }\n`,
  );
  console.log(`[fetch] sm-nightly ready: ${binPath} (build ${buildId})`);
}

/**
 * sm-pinned: SpiderMonkey release archives are permanent on
 * archive.mozilla.org (unlike jsc-built-products' rolling window — see
 * fetchJscPinned below), so no repo-owned mirror is needed here; the
 * upstream release URL from pins.json is fetched directly and verified by
 * sha256.
 */
async function fetchSpiderMonkeyPinned(): Promise<void> {
  const pins = await loadPins();
  const arch = smArch();
  const identity = `pin:${pins.spidermonkey.version}:${arch}`;
  const dir = join(cacheRoot, "sm-pinned");
  const binPath = join(dir, "js");
  if (await cacheMatches(dir, identity)) {
    console.log(`[fetch] sm-pinned already cached at ${binPath} (${identity})`);
    return;
  }
  const url = pins.spidermonkey.urlTemplate.replace("{arch}", arch);
  const expectedSha = pins.spidermonkey.sha256[arch];
  if (!expectedSha) {
    throw new Error(
      `pins.json has no spidermonkey.sha256 entry for arch '${arch}'`,
    );
  }
  console.log(`[fetch] sm-pinned (${pins.spidermonkey.version}): ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== expectedSha) {
    // Supply-chain + determinism: a pinned artifact that doesn't match its
    // recorded hash is refused, never silently used.
    throw new Error(
      `sm-pinned sha256 mismatch for ${url}\n  expected: ${expectedSha}\n  actual  : ${actualSha}`,
    );
  }
  const zipPath = join(cacheRoot, "sm-pinned.zip");
  await Deno.mkdir(cacheRoot, { recursive: true });
  await Deno.writeFile(zipPath, bytes);
  await extractZip(zipPath, dir);
  await Deno.remove(zipPath);
  await Deno.chmod(binPath, 0o755);
  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `${identity}\nurl: ${url}\nsha256: ${actualSha}\nfetched: ${
      new Date().toISOString()
    }\n`,
  );
  console.log(`[fetch] sm-pinned ready: ${binPath} (${identity}, sha256 verified)`);
}

async function fetchJscTrunk(): Promise<void> {
  if (Deno.build.arch !== "x86_64") {
    throw new Error(
      `jsc-built-products only publishes x86_64 trunk builds (issue #22); ` +
        `this host is ${Deno.build.arch}. For local machinery validation on ` +
        `other arches, extract a distro-stable jsc instead and pass ` +
        `--shell-bin/--lib-path to run-lane.ts (see that file's header for ` +
        `the apt-get/dpkg-deb recipe).`,
    );
  }
  const dir = join(cacheRoot, "jsc-trunk");
  const binPath = join(dir, "jsc");
  try {
    await Deno.stat(binPath);
    console.log(`[fetch] jsc-trunk already cached at ${binPath}`);
    return;
  } catch {
    // not cached — fetch below
  }
  const base = "https://webkitgtk.org/jsc-built-products/x86_64/release";
  const lastIs = (await (await fetch(`${base}/LAST-IS`)).text()).trim();
  console.log(`[fetch] jsc-trunk: LAST-IS = ${lastIs}`);
  const url = `${base}/${lastIs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const zipPath = join(cacheRoot, "jsc-trunk.zip");
  await Deno.mkdir(cacheRoot, { recursive: true });
  await Deno.writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
  await extractJscBundle(zipPath, dir);
  await Deno.remove(zipPath);

  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `LAST-IS: ${lastIs}\nfetched: ${new Date().toISOString()}\n`,
  );
  console.log(
    `[fetch] jsc-trunk ready: ${binPath} (rev ${lastIs}; self-contained bundle, ` +
      `executed via its wrapper — details in ${join(dir, "README.txt")})`,
  );
}

/**
 * jsc-pinned: unlike SpiderMonkey release archives, webkitgtk.org's
 * jsc-built-products only retains a rolling window of ~42 builds — a
 * pinned upstream URL for an old rev rots within weeks. So the exact rev
 * validated at parity by the canary (318852@main) is mirrored to a
 * repo-owned GitHub release (`shell-pins` tag) instead, fetched here and
 * sha256-verified. The mirrored bytes are byte-identical to the build the
 * canary ran (same rev, same hash) — this is not a rebuild.
 */
async function fetchJscPinned(): Promise<void> {
  const pins = await loadPins();
  if (pins.jsc.arch === "x86_64-only" && Deno.build.arch !== "x86_64") {
    throw new Error(
      `jsc-pinned (rev ${pins.jsc.rev}) is x86_64-only — no arm64 channel ` +
        `for JSC trunk/pinned builds; this host is ${Deno.build.arch}. ` +
        `Per-push CI coverage for jsc-pinned runs on the x64 leg of ci.yml's ` +
        `core matrix only. For local machinery validation on other arches, ` +
        `extract a distro-stable jsc instead and pass --shell-bin/--lib-path ` +
        `to run-lane.ts (see that file's header for the apt-get/dpkg-deb recipe).`,
    );
  }
  const dir = join(cacheRoot, "jsc-pinned");
  const binPath = join(dir, "jsc");
  const identity = `pin:${pins.jsc.rev}`;
  if (await cacheMatches(dir, identity)) {
    console.log(`[fetch] jsc-pinned already cached at ${binPath} (${identity})`);
    return;
  }
  console.log(`[fetch] jsc-pinned (rev ${pins.jsc.rev}): ${pins.jsc.url}`);
  const res = await fetch(pins.jsc.url);
  if (!res.ok) {
    throw new Error(`fetch ${pins.jsc.url}: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== pins.jsc.sha256) {
    throw new Error(
      `jsc-pinned sha256 mismatch for ${pins.jsc.url}\n  expected: ${pins.jsc.sha256}\n  actual  : ${actualSha}`,
    );
  }
  const zipPath = join(cacheRoot, "jsc-pinned.zip");
  await Deno.mkdir(cacheRoot, { recursive: true });
  await Deno.writeFile(zipPath, bytes);
  await extractJscBundle(zipPath, dir);
  await Deno.remove(zipPath);

  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `${identity}\nurl: ${pins.jsc.url}\nsha256: ${actualSha}\nfetched: ${
      new Date().toISOString()
    }\n`,
  );
  console.log(
    `[fetch] jsc-pinned ready: ${binPath} (rev ${pins.jsc.rev}, sha256 ` +
      `verified; self-contained bundle, executed via its wrapper — details ` +
      `in ${join(dir, "README.txt")})`,
  );
}

/**
 * Shared JSC bundle extraction + layout sanity check (used by both
 * jsc-trunk and jsc-pinned — same bundle shape either way).
 */
async function extractJscBundle(zipPath: string, dir: string): Promise<void> {
  // The archive is a SELF-CONTAINED bundle (built on the WebKit buildbots'
  // OS, newer than any runner) and must be kept intact and executed via its
  // own top-level `jsc` WRAPPER — a compiled C program (source ships as
  // jsc.c in the bundle) that chdir()s into the bundle directory, sets
  // LD_LIBRARY_PATH to the bundled `lib/` (which includes its own
  // ld-linux-x86-64.so.2 and ICU), and exec()s `bin/jsc`. The real binary
  // is NOT relocatable: its PT_INTERP is the *relative* path
  // `lib/ld-linux-x86-64.so.2` (verified with readelf), so executing it
  // outside the bundle root fails with ENOENT — the exact failure of this
  // lane's first CI run. The bundle's README.txt says the same in prose.
  // The wrapper absolutizes relative argv paths against the caller's CWD
  // before the chdir, so callers may pass paths freely.
  await extractZip(zipPath, dir);

  // Layout sanity check — loud if upstream's generate-bundle output changes.
  for (const p of ["jsc", "bin/jsc", "lib/ld-linux-x86-64.so.2"]) {
    try {
      await Deno.stat(join(dir, p));
    } catch {
      throw new Error(
        `jsc bundle layout changed: expected '${p}' under ${dir} — read ` +
          `${join(dir, "README.txt")} (shipped in the bundle) and update ` +
          `extractJscBundle to match`,
      );
    }
  }
  // Belt and braces on top of extractZip's mode restoration.
  await Deno.chmod(join(dir, "jsc"), 0o755);
  await Deno.chmod(join(dir, "bin", "jsc"), 0o755);
}

/**
 * node-pinned: official nodejs.org dist tarball, sha256-verified against
 * pins.json (hashes transcribed from the release's SHASUMS256.txt). Release
 * tarballs are permanent, so no mirror is needed (sm-pinned situation, not
 * jsc-pinned). Both linux arches are published — this lane runs on both CI
 * legs, unlike jsc-pinned.
 */
async function fetchNodePinned(): Promise<void> {
  const pins = await loadPins();
  // nodejs.org arch naming: x64 / arm64.
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  const identity = `pin:node-v${pins.node.version}:${arch}`;
  const dir = join(cacheRoot, "node-pinned");
  const binPath = join(dir, "bin", "node");
  if (await cacheMatches(dir, identity)) {
    console.log(`[fetch] node-pinned already cached at ${binPath} (${identity})`);
    return;
  }
  const url = pins.node.urlTemplate
    .replaceAll("{version}", pins.node.version)
    .replace("{arch}", arch);
  const expectedSha = pins.node.sha256[arch];
  if (!expectedSha) {
    throw new Error(`pins.json has no node.sha256 entry for arch '${arch}'`);
  }
  console.log(`[fetch] node-pinned (v${pins.node.version}): ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(
      `node-pinned sha256 mismatch for ${url}\n  expected: ${expectedSha}\n  actual  : ${actualSha}`,
    );
  }
  const tarPath = join(cacheRoot, "node-pinned.tar.xz");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(tarPath, bytes);
  // System tar (every runner/dev box in this repo's matrix ships one with
  // xz support — same dependency posture as extractZip's python3).
  // --strip-components=1 drops the versioned `node-v{V}-linux-{arch}/` top
  // directory so defaultShellPaths stays stable across pin bumps.
  const tar = new Deno.Command("tar", {
    args: ["-xJf", tarPath, "-C", dir, "--strip-components=1"],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await tar.output();
  if (code !== 0) throw new Error(`tar extraction failed (${tarPath})`);
  await Deno.remove(tarPath);
  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `${identity}\nurl: ${url}\nsha256: ${actualSha}\nfetched: ${
      new Date().toISOString()
    }\n`,
  );
  console.log(`[fetch] node-pinned ready: ${binPath} (${identity}, sha256 verified)`);
}

/**
 * bun-pinned: oven-sh/bun GitHub release zip, sha256-verified against
 * pins.json (hashes transcribed from the release's SHASUMS256.txt). Release
 * assets are permanent; both linux arches are published. The plain (AVX2)
 * x64 build is pinned — every runner in this repo's matrix has AVX2; the
 * `-baseline` variant exists if that ever changes.
 */
async function fetchBunPinned(): Promise<void> {
  const pins = await loadPins();
  // bun release-asset arch naming: x64 / aarch64.
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x64";
  const identity = `pin:bun-v${pins.bun.version}:${arch}`;
  const dir = join(cacheRoot, "bun-pinned");
  const binPath = join(dir, "bun");
  if (await cacheMatches(dir, identity)) {
    console.log(`[fetch] bun-pinned already cached at ${binPath} (${identity})`);
    return;
  }
  const url = pins.bun.urlTemplate
    .replaceAll("{version}", pins.bun.version)
    .replace("{arch}", arch);
  const expectedSha = pins.bun.sha256[arch];
  if (!expectedSha) {
    throw new Error(`pins.json has no bun.sha256 entry for arch '${arch}'`);
  }
  console.log(`[fetch] bun-pinned (v${pins.bun.version}): ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(
      `bun-pinned sha256 mismatch for ${url}\n  expected: ${expectedSha}\n  actual  : ${actualSha}`,
    );
  }
  const zipPath = join(cacheRoot, "bun-pinned.zip");
  await Deno.mkdir(cacheRoot, { recursive: true });
  await Deno.writeFile(zipPath, bytes);
  await extractZip(zipPath, dir);
  await Deno.remove(zipPath);
  // The zip nests the binary as `bun-linux-{arch}/bun`; copy it up to a
  // stable, arch-independent path for defaultShellPaths. (Single static
  // binary — a copy, not a symlink, so the nested dir could even be pruned.)
  await Deno.copyFile(join(dir, `bun-linux-${arch}`, "bun"), binPath);
  // Belt and braces on top of extractZip's mode restoration.
  await Deno.chmod(binPath, 0o755);
  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `${identity}\nurl: ${url}\nsha256: ${actualSha}\nfetched: ${
      new Date().toISOString()
    }\n`,
  );
  console.log(`[fetch] bun-pinned ready: ${binPath} (${identity}, sha256 verified)`);
}

async function main() {
  const lane = Deno.args[0];
  if (lane === "sm-nightly") await fetchSpiderMonkeyNightly();
  else if (lane === "sm-pinned") await fetchSpiderMonkeyPinned();
  else if (lane === "jsc-trunk") await fetchJscTrunk();
  else if (lane === "jsc-pinned") await fetchJscPinned();
  else if (lane === "node-pinned") await fetchNodePinned();
  else if (lane === "bun-pinned") await fetchBunPinned();
  else {
    console.error(
      `usage: deno run -A tools/shell/fetch.ts <sm-pinned|sm-nightly|jsc-pinned|jsc-trunk|node-pinned|bun-pinned>`,
    );
    Deno.exit(2);
  }
}

if (import.meta.main) await main();
