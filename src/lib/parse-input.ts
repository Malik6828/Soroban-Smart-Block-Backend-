import type { ZodTypeAny } from 'zod';

/**
 * Validate `data` with `schema` and re-assert the schema's intended output type.
 *
 * Why this exists: this project runs with `strictNullChecks: false` (see
 * tsconfig.json). Zod decides whether an object key is optional by testing
 * `undefined extends T[K]`, and with strict null checks disabled `undefined` is
 * assignable to every type — so `z.infer`/`schema.parse()` degrade every
 * property to optional. The runtime validation is completely unaffected; only
 * the static type is weakened.
 *
 * Passing the target type explicitly (e.g. the `*Input` interface a function
 * consumes) keeps the required/optional shape the rest of the code already
 * assumes, without widening anything to `any`.
 */
export function parseInput<T>(schema: ZodTypeAny, data: unknown): T {
  return schema.parse(data) as T;
}
