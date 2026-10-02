import type { Prisma } from '@prisma/client';

/**
 * Coerce an already-validated JSON-like value into Prisma's `InputJsonValue`.
 *
 * Values that reach this helper have already been checked by a Zod schema, so
 * the runtime shape is known to be JSON-serialisable. TypeScript cannot infer
 * that because Zod's object output inference degrades when `strictNullChecks`
 * is disabled, so the value arrives here as `unknown`. The cast is therefore
 * narrowed to Prisma's own JSON input type instead of `any`.
 */
export function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * Same as {@link jsonInput} but maps `undefined`/`null` to Prisma's explicit
 * `DbNull` sentinel, for nullable JSON columns.
 */
export function nullableJsonInput(
  value: unknown,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  if (value === null || value === undefined) {
    return { set: null } as unknown as Prisma.NullableJsonNullValueInput;
  }
  return value as Prisma.InputJsonValue;
}
