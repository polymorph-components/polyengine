// Test-only entry exposing the bundled copy's protocol classes to dual_copy_test.
// buildBundle(out, entry) selects this instead of the shipped application entry.
export * from "./entry.ts";
export {
  ComponentException,
  isStream,
  isSuspending,
  runtimeCopies,
  suspending,
} from "@polyengine/protocol";
