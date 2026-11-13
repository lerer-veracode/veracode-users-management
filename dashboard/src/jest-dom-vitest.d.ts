// Types for the jest-dom matchers (toBeInTheDocument and the rest) in Vitest 5.
// jest-dom's own "@testing-library/jest-dom/vitest" types extend `Assertion<T>`, which Vitest 5
// replaced with `Assertion<R, T>`, so they no longer apply. Vitest 5 has a `Matchers<R, T>`
// interface for custom matchers; this adds jest-dom's to it.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  // An augmentation must repeat Vitest's type parameters exactly, used or not, and adds its
  // members through `extends`, so these two rules don't apply here.
  /* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > extends TestingLibraryMatchers<unknown, R> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
}
