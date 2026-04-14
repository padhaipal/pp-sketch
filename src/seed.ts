import { AppDataSource } from './interfaces/database/data-source';
import { UserEntity } from './users/user.entity';
import { validateCreateUserOptions } from './users/user.dto';
import * as bcrypt from 'bcrypt';

const SEED_PHONE = '919000000000';
const SEED_PASSWORD = 'admin123';

async function seed() {
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
