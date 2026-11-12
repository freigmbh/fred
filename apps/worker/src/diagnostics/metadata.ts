import type { z } from "zod";

export function accepted<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}
