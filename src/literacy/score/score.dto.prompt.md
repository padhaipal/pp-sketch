```typescript
// Matches the pg scores table
export interface Score {
  id: string;                  // UUID PK
  user_id: string;             // FK -> users.id
  letter_id: string;           // FK -> letters.id
  score: number;               // DOUBLE PRECISION
  created_at: Date;            // TIMESTAMPTZ, default now()
}
```
