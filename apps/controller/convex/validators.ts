import { v } from "convex/values";

// The Convex validator for a contracts enum, such as `literals(provider.options)`, so stored literals follow the zod vocabulary.
export function literals<const Literal extends string>(values: readonly Literal[]) {
  return v.union(...values.map((value) => v.literal(value)));
}
