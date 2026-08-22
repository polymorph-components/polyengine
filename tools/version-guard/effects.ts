// The effects the guard needs from the outside world, as one injectable
// interface: every check below is a pure function over this, so the unit
// tests run the real decision logic against fixtures with no network, no
// `gh`, and no repository state. `realEffects()` is the only place that
// touches Deno APIs.

export type HttpResponse = { status: number; body: string };

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export interface Effects {
  /** GET a URL as text. A non-2xx is a normal return, not a throw: 404 is a
   * meaningful answer to "is this version published?". */
  fetchText(url: string): Promise<HttpResponse>;
  /** Run a command (`gh`, `git`) and capture it. */
  run(cmd: string, args: string[]): Promise<CommandResult>;
  /** File bytes, or null when the path does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Every file below `dir`, recursively, as paths relative to `dir` with
   * `/` separators. Empty when `dir` does not exist. */
  listFiles(dir: string): Promise<string[]>;
  writeFile(path: string, text: string): Promise<void>;
  env(name: string): string | undefined;
  log(message: string): void;
}

export function realEffects(): Effects {
  return {
    async fetchText(url) {
      const res = await fetch(url);
      return { status: res.status, body: await res.text() };
    },
    async run(cmd, args) {
      const out = await new Deno.Command(cmd, {
        args,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const dec = new TextDecoder();
      return {
        code: out.code,
        stdout: dec.decode(out.stdout),
        stderr: dec.decode(out.stderr),
      };
    },
    async readFile(path) {
      try {
        return await Deno.readFile(path);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return null;
        throw e;
      }
    },
    async listFiles(dir) {
      const out: string[] = [];
      const walk = async (rel: string) => {
        let entries: Deno.DirEntry[];
        try {
          entries = [...Deno.readDirSync(rel === "" ? dir : `${dir}/${rel}`)];
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) return;
          throw e;
        }
        for (const entry of entries) {
          const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory) await walk(child);
          else out.push(child);
        }
      };
      await walk("");
      out.sort();
      return out;
    },
    writeFile: (path, text) => Deno.writeTextFile(path, text),
    env: (name) => Deno.env.get(name),
    log: (message) => console.log(message),
  };
}

/** sha256 of raw bytes as lowercase hex — the digest JSR's version manifests
 * carry (`"checksum": "sha256-<hex>"`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A `gh api` call. `gh` exits non-zero on an error status and prints e.g.
 * `gh: Not Found (HTTP 404)`; the status is recovered from that so callers
 * can distinguish "no release cut yet" (404, a legitimate state) from a
 * token or network failure (everything else, which must fail loudly). */
export async function ghApi(
  fx: Effects,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const res = await fx.run("gh", ["api", path]);
  if (res.code === 0) return { status: 200, json: JSON.parse(res.stdout) };
  const m = /HTTP (\d{3})/.exec(res.stderr);
  if (m) return { status: Number(m[1]), json: null };
  throw new Error(
    `gh api ${path} failed (exit ${res.code}) with no HTTP status:\n${res.stderr.trim()}`,
  );
}
