import { z } from 'zod';

export const PresetModulesSchema = z.record(z.string(), z.unknown());

export const ServerPresetSchema = z.object({
  id:          z.string().uuid(),
  jobName:     z.string(),
  category:    z.string(),
  description: z.string(),
  visibility:  z.enum(['private', 'organization']),
  revision:    z.number().int().min(1),
  modules:     PresetModulesSchema,
  ownerUserId: z.string().uuid(),
  source:      z.literal('custom'),
  createdAt:   z.string(),
  updatedAt:   z.string(),
});

export const CreatePresetBodySchema = z.object({
  jobName:     z.string().trim().min(1).max(200),
  category:    z.string().trim().max(100).default('미분류'),
  description: z.string().trim().max(500).default(''),
  visibility:  z.enum(['private', 'organization']).default('private'),
  modules:     PresetModulesSchema,
});

export const UpdatePresetBodySchema = z.object({
  jobName:        z.string().trim().min(1).max(200).optional(),
  category:       z.string().trim().max(100).optional(),
  description:    z.string().trim().max(500).optional(),
  visibility:     z.enum(['private', 'organization']).optional(),
  modules:        PresetModulesSchema.optional(),
  replaceModules: z.boolean().optional(),
});

export const GetPresetsResponseSchema = z.object({
  presets: z.array(ServerPresetSchema),
});

export type ServerPreset     = z.infer<typeof ServerPresetSchema>;
export type CreatePresetBody = z.infer<typeof CreatePresetBodySchema>;
export type UpdatePresetBody = z.infer<typeof UpdatePresetBodySchema>;
