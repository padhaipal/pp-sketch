```typescript
import { BadRequestException } from '@nestjs/common';

// Matches the pg ai_providers table
export interface AiProvider {
  id: string;                  // UUID PK
  name: string;                // unique — functions as an external id
  website: string | null;      // TEXT, nullable
  created_at: Date;            // TIMESTAMPTZ, default now()
}

// --- Options types ---

export interface FindAiProviderOptions {
  id?: string;
  name?: string;
}

export interface UpdateAiProviderOptions {
  id?: string;
  name?: string;
  new_name?: string;
  new_website?: string | null;
}

export interface CreateAiProviderOptions {
  name: string;
  website?: string;
}

// --- Batch limit ---

const parsed = parseInt(process.env.MAX_AI_PROVIDER_BATCH_SIZE ?? '100', 10);
export const MAX_AI_PROVIDER_BATCH_SIZE = Number.isNaN(parsed) || parsed <= 0 ? 100 : parsed;

// --- Runtime validation ---

export function validateFindAiProviderOptions(options: unknown): FindAiProviderOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('find() options must be an object');
  }
  const { id, name } = options as Record<string, unknown>;
  if (id !== undefined && typeof id !== 'string') {
    throw new BadRequestException('find() options.id must be a string');
  }
  if (name !== undefined && typeof name !== 'string') {
    throw new BadRequestException('find() options.name must be a string');
  }
  if (id !== undefined && name !== undefined) {
    throw new BadRequestException('find() requires exactly one of id or name, not both');
  }
  if (id === undefined && name === undefined) {
    throw new BadRequestException('find() requires exactly one of id or name');
  }
  return { id, name } as FindAiProviderOptions;
}

export function validateUpdateAiProviderOptions(options: unknown): UpdateAiProviderOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('update() options must be an object');
  }
  const { id, name, new_name, new_website } = options as Record<string, unknown>;
  if (id !== undefined && typeof id !== 'string') {
    throw new BadRequestException('update() options.id must be a string');
  }
  if (name !== undefined && typeof name !== 'string') {
    throw new BadRequestException('update() options.name must be a string');
  }
  if (id !== undefined && name !== undefined) {
    throw new BadRequestException('update() requires exactly one of id or name to identify the provider, not both');
  }
  if (id === undefined && name === undefined) {
    throw new BadRequestException('update() requires exactly one of id or name to identify the provider');
  }
  if (new_name !== undefined && typeof new_name !== 'string') {
    throw new BadRequestException('update() options.new_name must be a string');
  }
  if (new_website !== undefined && new_website !== null && typeof new_website !== 'string') {
    throw new BadRequestException('update() options.new_website must be a string or null');
  }
  if (new_name === undefined && new_website === undefined) {
    throw new BadRequestException('update() requires at least one field to update (new_name, new_website)');
  }
  return { id, name, new_name, new_website } as UpdateAiProviderOptions;
}

export function validateCreateAiProviderOptions(options: unknown): CreateAiProviderOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('create() options must be an object');
  }
  const { name, website } = options as Record<string, unknown>;
  if (typeof name !== 'string' || name.length === 0) {
    throw new BadRequestException('create() options.name is required and must be a non-empty string');
  }
  if (website !== undefined && typeof website !== 'string') {
    throw new BadRequestException('create() options.website must be a string');
  }
  return { name, website } as CreateAiProviderOptions;
}
```
