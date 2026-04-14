import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UserService } from './users/user.service';
import { UserEntity } from './users/user.entity';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';

const SEED_PHONE = '919000000000';
const SEED_PASSWORD = 'admin123';

async function seed() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const userService = app.get(UserService);
  const userRepo = app.get<Repository<UserEntity>>(
    getRepositoryToken(UserEntity),
  );

  const existing = await userService.find({ external_id: SEED_PHONE });
  if (existing) {
    console.log(`Seed user already exists (id=${existing.id}), skipping.`);
  } else {
    const user = await userService.create({ external_id: SEED_PHONE });
    await userRepo.update(user.id, {
      password_hash: await bcrypt.hash(SEED_PASSWORD, 10),
      role: 'dev',
    });
    console.log(`Seed user created (id=${user.id}).`);
  }

  await app.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
