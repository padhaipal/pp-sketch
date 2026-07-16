import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundMessageEntity } from './outbound-message.entity';
import { OutboundMessageService } from './outbound-message.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboundMessageEntity])],
  providers: [OutboundMessageService],
  exports: [OutboundMessageService],
})
export class OutboundMessageModule {}
