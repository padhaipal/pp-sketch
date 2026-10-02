import {
  ForbiddenException,
  Logger,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ApiKeyGuard,
  clientIp,
  type AuthenticatedRequest,
} from './api-key.guard';
import { Public } from './public.decorator';

function ctx(
  req: Partial<AuthenticatedRequest> & { headers?: Record<string, string> },
  handler: object = () => undefined,
  cls: object = class {},
): { context: ExecutionContext; req: AuthenticatedRequest } {
  const headers = req.headers ?? {};
  const full = {
    method: 'GET',
    path: '/users',
    ip: '10.0.0.1',
    header: (name: string) => headers[name.toLowerCase()],
    ...req,
  } as unknown as AuthenticatedRequest;
  return {
    req: full,
    context: {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => full }),
    } as unknown as ExecutionContext,
  };
}

describe('ApiKeyGuard', () => {
  const ORIG = { ...process.env };
  let warn: jest.SpyInstance;
  beforeEach(() => {
    process.env.DASHBOARD_API_KEY = 'dash-secret';
    process.env.WABOT_INBOUND_API_KEY = 'wabot-key';
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    process.env = { ...ORIG };
  });
  const guard = () => new ApiKeyGuard(new Reflector());

  it('lets a valid dashboard key through and tags the request with its caller', () => {
    const { context, req } = ctx({ headers: { 'x-api-key': 'dash-secret' } });
    expect(guard().canActivate(context)).toBe(true);
    expect(req.apiCaller).toBe('dashboard');
    expect(warn).not.toHaveBeenCalled();
  });

  it('401s a missing or wrong key and logs route + client ip + reason, never the key', () => {
    const { context } = ctx({
      method: 'PATCH',
      path: '/users/abc',
      headers: {
        'x-api-key': 'wrong-key',
        'x-forwarded-for': '203.0.113.9, 10.0.0.2',
      },
    });
    expect(() => guard().canActivate(context)).toThrow(UnauthorizedException);
    expect(warn).toHaveBeenCalledWith(
      'rejected PATCH /users/abc ip=203.0.113.9 reason=invalid',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('wrong-key');

    const missing = ctx({ path: '/users' });
    expect(() => guard().canActivate(missing.context)).toThrow(
      UnauthorizedException,
    );
    expect(warn).toHaveBeenLastCalledWith(
      'rejected GET /users ip=10.0.0.1 reason=missing',
    );
  });

  it("403s wabot's key outside /wabot/inbound", () => {
    const { context } = ctx({
      path: '/users',
      headers: { 'x-api-key': 'wabot-key' },
    });
    expect(() => guard().canActivate(context)).toThrow(ForbiddenException);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('reason=forbidden_route'),
    );
    const ok = ctx({
      method: 'POST',
      path: '/wabot/inbound',
      headers: { 'x-api-key': 'wabot-key' },
    });
    expect(guard().canActivate(ok.context)).toBe(true);
    expect(ok.req.apiCaller).toBe('wabot');
  });

  it('skips the check for @Public() handlers and classes', () => {
    class PublicCtrl {}
    Public()(PublicCtrl);
    const byClass = ctx({}, () => undefined, PublicCtrl);
    expect(guard().canActivate(byClass.context)).toBe(true);
    expect(byClass.req.apiCaller).toBeUndefined();

    const handler = () => undefined;
    Public()(handler);
    expect(guard().canActivate(ctx({}, handler).context)).toBe(true);
  });

  it('reads the keys once at construction: a key rotated afterwards is not seen until redeploy', () => {
    const g = guard();
    process.env.DASHBOARD_API_KEY = 'rotated';
    expect(
      g.canActivate(ctx({ headers: { 'x-api-key': 'dash-secret' } }).context),
    ).toBe(true);
    expect(() =>
      g.canActivate(ctx({ headers: { 'x-api-key': 'rotated' } }).context),
    ).toThrow(UnauthorizedException);
  });

  it('fails closed with no keys configured', () => {
    delete process.env.DASHBOARD_API_KEY;
    delete process.env.WABOT_INBOUND_API_KEY;
    expect(() =>
      guard().canActivate(
        ctx({ headers: { 'x-api-key': 'dash-secret' } }).context,
      ),
    ).toThrow(UnauthorizedException);
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>, ip?: string) =>
    ({ header: (n: string) => headers[n], ip }) as never;
  it('prefers the first X-Forwarded-For hop, then req.ip, then unknown', () => {
    expect(
      clientIp(req({ 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' }, '9.9.9.9')),
    ).toBe('1.2.3.4');
    expect(clientIp(req({}, '9.9.9.9'))).toBe('9.9.9.9');
    expect(clientIp(req({}))).toBe('unknown');
  });
});
