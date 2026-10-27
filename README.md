# pp-sketch

pp = PadhaiPal, LIFTeracy's name before the rebrand.

Backend for lessons, users and the dashboard API. NestJS, PostgreSQL (TypeORM), BullMQ/Redis.

```bash
cp .env.example .env
npm ci
npm run migration:run
npm run start:dev
npm test
```

Deploys to Railway; `main` → staging.

## Licence

Code: [MIT](LICENSE). The LIFTeracy name and logo are **not** licensed; forks must not use them.
