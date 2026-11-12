import { z } from "zod";

export const decisionPublication = z.object({
  body: z.string().min(1),
  discussionId: z.string().optional(),
  resolved: z.boolean(),
  label: z.enum(["clean", "findings"]),
});
