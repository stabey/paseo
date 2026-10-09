import { z } from "zod";

export const WorkspacePortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  label: z.string().max(80),
  protocol: z.enum(["http", "https", "tcp"]),
});

export type WorkspacePort = z.infer<typeof WorkspacePortSchema>;
