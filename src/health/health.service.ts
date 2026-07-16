import { Inject, Injectable, Optional } from '@nestjs/common';

export const READINESS_PROBES = Symbol('READINESS_PROBES');

export interface ReadinessProbe {
  readonly name: string;
  check(): boolean | void | Promise<boolean | void>;
}

export interface LivenessResult {
  status: 'ok';
}

export interface ReadinessCheckResult {
  name: string;
  status: 'up' | 'down';
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: ReadonlyArray<ReadinessCheckResult>;
}

@Injectable()
export class HealthService {
  private readonly probes: readonly ReadinessProbe[];

  constructor(
    @Optional()
    @Inject(READINESS_PROBES)
    probes?: readonly ReadinessProbe[],
  ) {
    this.probes = probes ?? [];
  }

  liveness(): LivenessResult {
    return { status: 'ok' };
  }

  async readiness(): Promise<ReadinessResult> {
    const checks = await Promise.all(
      this.probes.map((probe, index) => this.runProbe(probe, index)),
    );

    return {
      status: checks.every(check => check.status === 'up')
        ? 'ready'
        : 'not_ready',
      checks,
    };
  }

  private async runProbe(
    probe: ReadinessProbe,
    index: number,
  ): Promise<ReadinessCheckResult> {
    const name = publicProbeName(probe, index);

    try {
      const result = await probe.check();
      return { name, status: result === false ? 'down' : 'up' };
    } catch {
      return { name, status: 'down' };
    }
  }
}

function publicProbeName(probe: ReadinessProbe, index: number): string {
  let name = '';

  try {
    name = typeof probe.name === 'string' ? probe.name.trim() : '';
  } catch {
    return `probe-${index + 1}`;
  }

  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)
    ? name
    : `probe-${index + 1}`;
}
