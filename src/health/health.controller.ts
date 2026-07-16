import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HealthService,
  LivenessResult,
  ReadinessResult,
} from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  health(): LivenessResult {
    return this.healthService.liveness();
  }

  @Get('live')
  live(): LivenessResult {
    return this.healthService.liveness();
  }

  @Get('liveness')
  liveness(): LivenessResult {
    return this.healthService.liveness();
  }

  @Get('ready')
  async readiness(): Promise<ReadinessResult> {
    const result = await this.healthService.readiness();
    if (result.status === 'not_ready') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
