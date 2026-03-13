```typescript
// Matches the pg letters table
export interface Letter {
  id: string;                              // UUID PK
  grapheme: string;                        // unique, functions as an external id
  media_metadata_id?: string | null;       // FK -> media_metadata.id
  created_at: Date;                        // TIMESTAMPTZ, default now()
}
```
