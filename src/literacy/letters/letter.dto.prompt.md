```typescript
// Matches the pg letters table
export interface Letter {
  id: string;                              // UUID PK
  grapheme: string;                        // unique, functions as an external id
  media_metadata_id?: string | null;       // FK -> media_metadata.id
  created_at: Date;                        // TIMESTAMPTZ, default now()
}

export interface CreateLetterOptions {
  grapheme: string;                        // required, must be non-empty
  media_metadata_id?: string | null;       // optional FK
}

export interface CreateBulkLetterOptions {
  items: CreateLetterOptions[];            // min length 1
}

export interface UpdateLetterOptions {
  grapheme: string;                        // identifies the letter to update
  new_grapheme?: string;                   // rename the grapheme
  new_media_metadata_id?: string | null;   // set or clear the FK (pass null to remove)
  // At least one of new_grapheme / new_media_metadata_id must be provided.
}

export interface DeleteLetterOptions {
  grapheme: string;                        // identifies the letter to delete
}
```

validateCreateLetterOptions(raw): asserts grapheme is a non-empty string. media_metadata_id, if provided, must be a non-empty string or null.

validateCreateBulkLetterOptions(raw): asserts items is a non-empty array; validates each item with validateCreateLetterOptions().

validateUpdateLetterOptions(raw): asserts grapheme is a non-empty string. Asserts at least one of new_grapheme / new_media_metadata_id is present. If new_grapheme is provided, it must be a non-empty string. If new_media_metadata_id is provided, it must be a non-empty string or null.

validateDeleteLetterOptions(raw): asserts grapheme is a non-empty string.
