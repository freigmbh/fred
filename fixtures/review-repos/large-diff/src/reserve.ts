import { assertAvailable } from "./assertAvailable";

export function reserve(available: number, requested: number) {
  assertAvailable(available, requested);
  return available - requested;
}
