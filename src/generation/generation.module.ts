import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExpertGenerationService } from './expert-generation.service';

@Module({
  imports: [ConfigModule],
  providers: [ExpertGenerationService],
  exports: [ExpertGenerationService],
})
export class GenerationModule {}
