import {
  Controller,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcrypt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from './user.entity';
import { LoginDto, SetRoleDto, UserRole } from './user.dto';

const VALID_ROLES: UserRole[] = ['admin', 'dev'];

@ApiTags('users')
@Controller('users')
export class UserController {
  private readonly logger = new Logger(UserController.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  @Post('login')
  async login(@Body() body: LoginDto) {
    const { phone, password } = body;
    this.logger.log(`[HPTRACE] login attempt phone=${phone}`);

    if (!phone || !password) {
      this.logger.warn(`[HPTRACE] login missing fields phone=${!!phone} password=${!!password}`);
      throw new BadRequestException('phone and password required');
    }

    const user = await this.userRepo.findOneBy({ external_id: phone });
    if (!user || !user.password_hash || !user.role) {
      this.logger.warn(`[HPTRACE] login user not found or missing hash/role phone=${phone} found=${!!user}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      this.logger.warn(`[HPTRACE] login password mismatch phone=${phone}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    this.logger.log(`[HPTRACE] login success phone=${phone} id=${user.id} role=${user.role}`);
    return { id: user.id, external_id: user.external_id, role: user.role };
  }

  @Patch(':id/role')
  async setRole(@Param('id') id: string, @Body() body: SetRoleDto) {
    const { phone, password, role } = body;
    if (!phone || !password || !role) {
      throw new BadRequestException('phone, password, and role required');
    }
    if (!VALID_ROLES.includes(role)) {
      throw new BadRequestException(`role must be one of: ${VALID_ROLES.join(', ')}`);
    }

    const user = await this.userRepo.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.external_id = phone;
    user.password_hash = await bcrypt.hash(password, 10);
    user.role = role;
    await this.userRepo.save(user);

    return { id: user.id, external_id: user.external_id, role: user.role };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const user = await this.userRepo.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    await this.userRepo.remove(user);
    return { deleted: true };
  }
}
