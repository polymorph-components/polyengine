// An in-memory Origin-Private-File-System fake, structurally satisfying
// filesystem_web.ts's Opfs*Handle interfaces (the point of keeping those
// structural). Deno has no `navigator.storage.getDirectory`, so the web
// backend's unit tests run against this; the REAL OPFS is exercised by
// the OPFS smoke (`just smoke-opfs`, tools/browser/opfs-smoke.ts).
// Error spellings mirror the spec's DOMException
// names (`NotFoundError`, `TypeMismatchError`, `InvalidModificationError`)
// because that is exactly what the backend's error mapper consumes.
//
// Deliberately unimplemented: `move()` (absent on Firefox/Safari too) —
// which routes filesystem_web's rename through its copy+delete fallback.

import type {
  OpfsDirectoryHandle,
  OpfsFileHandle,
  OpfsFileLike,
  OpfsWritable,
} from "../../src/filesystem_web.ts";

function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

class FakeFileLike implements OpfsFileLike {
  constructor(readonly bytes: Uint8Array, readonly lastModified: number) {}
  get size(): number {
    return this.bytes.length;
  }
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } {
    const view = this.bytes.slice(start, end);
    return { arrayBuffer: () => Promise.resolve(view.buffer as ArrayBuffer) };
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.bytes.slice().buffer as ArrayBuffer);
  }
}

export class FakeFileHandle implements OpfsFileHandle {
  readonly kind = "file" as const;
  #data = new Uint8Array(0);
  #mtime = Date.now();

  constructor(readonly name: string) {}

  /** Test hook: current committed contents. */
  contents(): Uint8Array {
    return this.#data;
  }

  getFile(): Promise<OpfsFileLike> {
    return Promise.resolve(new FakeFileLike(this.#data, this.#mtime));
  }

  createWritable(opts?: { keepExistingData?: boolean }): Promise<OpfsWritable> {
    let buf = opts?.keepExistingData === true
      ? this.#data.slice()
      : new Uint8Array(0);
    let open = true;
    const requireOpen = (): void => {
      if (!open) throw domError("InvalidStateError", "writable already closed");
    };
    return Promise.resolve({
      write: (
        params: { type: "write"; position: number; data: Uint8Array },
      ) => {
        requireOpen();
        const end = params.position + params.data.length;
        if (end > buf.length) {
          const grown = new Uint8Array(end);
          grown.set(buf);
          buf = grown; // gap (if any) stays zero-filled
        }
        buf.set(params.data, params.position);
        return Promise.resolve();
      },
      truncate: (size: number) => {
        requireOpen();
        const next = new Uint8Array(size);
        next.set(buf.subarray(0, Math.min(size, buf.length)));
        buf = next;
        return Promise.resolve();
      },
      close: () => {
        requireOpen();
        open = false;
        this.#data = buf; // COMMIT on close, like the real thing
        this.#mtime = Date.now();
        return Promise.resolve();
      },
    });
  }

  isSameEntry(other: OpfsFileHandle | OpfsDirectoryHandle): Promise<boolean> {
    return Promise.resolve((other as unknown) === this);
  }
}

export class FakeDirectoryHandle implements OpfsDirectoryHandle {
  readonly kind = "directory" as const;
  #children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();

  constructor(readonly name: string) {}

  getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<OpfsDirectoryHandle> {
    const existing = this.#children.get(name);
    if (existing !== undefined) {
      if (existing.kind !== "directory") {
        return Promise.reject(
          domError("TypeMismatchError", `${name} is a file`),
        );
      }
      return Promise.resolve(existing);
    }
    if (opts?.create !== true) {
      return Promise.reject(domError("NotFoundError", `${name} not found`));
    }
    const dir = new FakeDirectoryHandle(name);
    this.#children.set(name, dir);
    return Promise.resolve(dir);
  }

  getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<OpfsFileHandle> {
    const existing = this.#children.get(name);
    if (existing !== undefined) {
      if (existing.kind !== "file") {
        return Promise.reject(
          domError("TypeMismatchError", `${name} is a directory`),
        );
      }
      return Promise.resolve(existing);
    }
    if (opts?.create !== true) {
      return Promise.reject(domError("NotFoundError", `${name} not found`));
    }
    const file = new FakeFileHandle(name);
    this.#children.set(name, file);
    return Promise.resolve(file);
  }

  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const existing = this.#children.get(name);
    if (existing === undefined) {
      return Promise.reject(domError("NotFoundError", `${name} not found`));
    }
    if (
      existing.kind === "directory" && opts?.recursive !== true &&
      existing.childCount() > 0
    ) {
      return Promise.reject(
        domError("InvalidModificationError", `${name} not empty`),
      );
    }
    this.#children.delete(name);
    return Promise.resolve();
  }

  async *entries(): AsyncIterable<
    [string, OpfsDirectoryHandle | OpfsFileHandle]
  > {
    for (const [name, handle] of this.#children) yield [name, handle];
  }

  isSameEntry(other: OpfsFileHandle | OpfsDirectoryHandle): Promise<boolean> {
    return Promise.resolve((other as unknown) === this);
  }

  /** Test hook. */
  childCount(): number {
    return this.#children.size;
  }
}
