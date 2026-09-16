import { z } from 'zod';
import { Constants, PromptSchedulePreset } from 'librechat-data-provider';
import type { TPromptGroupScheduleInput } from 'librechat-data-provider';

const objectIdString = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid ObjectId');

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm (24h)');

const cronSourceSchema = z
  .object({
    kind: z.literal('cron'),
    cron: z.string().trim().min(1).max(100),
  })
  .strict();

const presetSourceSchema = z
  .object({
    kind: z.literal('preset'),
    preset: z.nativeEnum(PromptSchedulePreset),
    time: timeString,
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
  })
  .strict();

const scheduleSourceSchema = z.discriminatedUnion('kind', [cronSourceSchema, presetSourceSchema]);

/**
 * Optional schedule parameters on a prompt group. All fields are optional so a partial
 * patch can update an existing schedule; the route enforces the required fields when a
 * schedule is first created.
 */
const promptGroupScheduleInputSchema = z
  .object({
    agent_id: z.string().trim().min(1).max(255).optional(),
    source: scheduleSourceSchema.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    promptId: objectIdString.nullable().optional(),
    variables: z.record(z.string().max(100), z.string().max(10_000)).optional(),
    enabled: z.boolean().optional(),
    notify: z.object({ email: z.boolean().optional() }).strict().optional(),
  })
  .strict();

/** Validated prompt group update payload. `schedule: null` clears the schedule. */
export type TUpdatePromptGroupSchema = {
  name?: string;
  oneliner?: string;
  category?: string;
  command?: string | null;
  schedule?: Partial<TPromptGroupScheduleInput> | null;
};

/**
 * Schema for validating prompt group update payloads.
 * Only allows fields that users should be able to modify.
 * Sensitive fields like author, authorName, _id, productionId, etc. are excluded.
 */
export const updatePromptGroupSchema: z.ZodType<TUpdatePromptGroupSchema, z.ZodTypeDef, unknown> = z
  .object({
    /** The name of the prompt group */
    name: z.string().min(1).max(255).optional(),
    /** Short description/oneliner for the prompt group */
    oneliner: z.string().max(500).optional(),
    /** Category for organizing prompt groups */
    category: z.string().max(100).optional(),
    /** Command shortcut for the prompt group */
    command: z
      .string()
      .max(Constants.COMMANDS_MAX_LENGTH as number)
      .regex(/^[a-z0-9-]*$/, {
        message: 'Command must only contain lowercase alphanumeric characters and hyphens',
      })
      .optional()
      .nullable(),
    /** Optional schedule parameters; `null` removes the schedule */
    schedule: promptGroupScheduleInputSchema.nullable().optional(),
  })
  .strict();

/**
 * Validates and sanitizes a prompt group update payload.
 * Returns only the allowed fields, stripping any sensitive fields.
 * @param data - The raw request body to validate
 * @returns The validated and sanitized payload
 * @throws ZodError if validation fails
 */
export function validatePromptGroupUpdate(data: unknown): TUpdatePromptGroupSchema {
  return updatePromptGroupSchema.parse(data);
}

/**
 * Safely validates a prompt group update payload without throwing.
 * @param data - The raw request body to validate
 * @returns A SafeParseResult with either the validated data or validation errors
 */
export function safeValidatePromptGroupUpdate(
  data: unknown,
): z.SafeParseReturnType<unknown, TUpdatePromptGroupSchema> {
  return updatePromptGroupSchema.safeParse(data);
}
