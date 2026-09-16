import { AppDataSource } from './interfaces/database/data-source';
import { UserEntity } from './users/user.entity';
import { validateCreateUserOptions } from './users/user.dto';
import * as bcrypt from 'bcrypt';

// Bootstrap dev login, from env only — never a default in the repo.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function seed() {
  const SEED_PHONE = required('SEED_PHONE');
  const SEED_PASSWORD = required('SEED_PASSWORD');
  const validated = validateCreateUserOptions({ external_id: SEED_PHONE });

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(UserEntity);

  const existing = await repo.findOneBy({
    external_id: validated.external_id,
  });
  if (existing) {
    console.log(`Seed user already exists (id=${existing.id}), skipping.`);
  } else {
    const user = repo.create({
      external_id: validated.external_id,
      password_hash: await bcrypt.hash(SEED_PASSWORD, 10),
      role: 'dev',
    });
    await repo.save(user);
    console.log(`Seed user created (id=${user.id}).`);
  }

  await AppDataSource.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
