// WIT label -> JS identifier casing, and the mangled export/import leaf
// grammar that carries resource membership.
//
// Governing contract: contracts/embedder-api.md §"Naming and casing".
// Casing applies to *identifiers* only — function/method/static names, record
// fields, flag names, resource class names. It NEVER applies to data: enum
// values, variant/result case tags and interface ids stay kebab-case verbatim.

/**
 * `get-resolution` -> `getResolution`.
 *
 * The rule, stated exactly: split the label on `-`; the first fragment is
 * unchanged; every later fragment has its first character upper-cased and its
 * remainder preserved. Preserving the remainder is what keeps acronym
 * fragments intact — `outgoing-HTTP-request` -> `outgoingHTTPRequest` — which
 * a naive `toLowerCase()` of the tail would destroy.
 *
 * WIT labels are already lower-kebab in practice, so the first fragment needs
 * no adjustment; nothing here lower-cases anything.
 * @internal — the runtime applies the naming rules; embedders write the
 * resulting JS names literally (contracts/embedder-api.md §"Naming and
 * casing").
 */
export function camelCase(label: string): string {
  const parts = label.split("-");
  return parts[0] + parts.slice(1).map(upperFirst).join("");
}

/**
 * `tcp-socket` -> `TcpSocket` (resource class names).
 * @internal — the runtime applies the naming rules; embedders write the
 * resulting class names literally.
 */
export function pascalCase(label: string): string {
  return label.split("-").map(upperFirst).join("");
}

function upperFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * A leaf name in `plan.exports` / `plan.imports`, decoded.
 *
 * The Component Model mangles resource membership into the name itself
 * (`[constructor]counter`, `[method]counter.increment`,
 * `[static]counter.merge`); embedders would otherwise hand-transcribe
 * these. Assembling and disassembling them is a runtime obligation.
 */
export type LeafName =
  | { form: "plain"; name: string }
  | { form: "constructor"; resource: string }
  | { form: "method"; resource: string; member: string }
  | { form: "static"; resource: string; member: string };

const MANGLED = /^\[([a-z-]+)\](.*)$/;

/**
 * Decode a mangled leaf name; unmangled names come back as `plain`.
 *
 * An unknown bracket form throws rather than falling back to `plain`
 * (contracts/embedder-api.md §"Getters and setters (pre-ruling…)", final
 * paragraph): "the runtime refuses unknown bracket forms in mangled names
 * loudly at instantiation (rather than misbinding them as plain names — a
 * `[get]foo` treated as a function named `[get]foo` would be wrong in both
 * directions)". Getter/setter support (`[get]`/`[set]`, upstream
 * WebAssembly/component-model#701) is tracked in polyengine#254.
 * @internal — leaf-name demangling, performed by the runtime and by
 * bindgen-generated code.
 */
export function parseLeafName(raw: string): LeafName {
  const m = MANGLED.exec(raw);
  if (m === null) return { form: "plain", name: raw };
  const [, tag, rest] = m;
  switch (tag) {
    case "constructor":
      if (!rest.includes("[")) return { form: "constructor", resource: rest };
      break;
    case "method":
    case "static": {
      const dot = rest.indexOf(".");
      if (dot < 0) break;
      const resource = rest.slice(0, dot);
      // A resource name carrying a further bracket (`[method][get]r.p`, the
      // exact getter/setter-on-instance spelling the pre-ruling names) is
      // NOT a plain `[method]`/`[static]` leaf — it is one of the still-
      // unimplemented forms, and must be refused the same way, not
      // misparsed as a method whose resource is literally `[get]r`.
      if (resource.includes("[")) break;
      return { form: tag, resource, member: rest.slice(dot + 1) };
    }
  }
  throw new Error(
    `unrecognized mangled export/import name '${raw}': the bracket form is ` +
      `not one this runtime understands (only [constructor]/[method]/` +
      `[static] are implemented; getter/setter forms like [get]/[set] are ` +
      `not yet implemented — polyengine#254)`,
  );
}
