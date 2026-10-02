import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { API_KEY_HEADER, authenticateApiKey, readApiKeys } from './api-keys';
import type { ApiCaller, ApiKeys } from './api-keys';
import { IS_PUBLIC_KEY } from './public.decorator';

// The request once the guard has let it through.
export interface AuthenticatedRequest extends Request {
  apiCaller?: ApiCaller;
}

// Registered as APP_GUARD (app.module.ts): every route needs a valid
// x-api-key unless it is @Public(). Rejections are logged with the route and
// the caller's address — never the key — so Grafana can alert on them.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  // Read once at construction (boot): rotating a key is a redeploy.
  private readonly keys: ApiKeys = readApiKeys();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const verdict = authenticateApiKey(
      req.header(API_KEY_HEADER),
      req.path,
      this.keys,
    );
    if (!verdict.ok) {
      this.logger.warn(
        `rejected ${req.method} ${req.path} ip=${clientIp(req)} reason=${verdict.reason}`,
      );
      if (verdict.reason === 'forbidden_route') throw new ForbiddenException();
      throw new UnauthorizedException();
    }
    req.apiCaller = verdict.caller;
    return true;
  }
}

// Railway fronts the service with a proxy, so the client is the first hop of
// X-Forwarded-For; req.ip would be the proxy.
export function clientIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip ?? 'unknown';
}
