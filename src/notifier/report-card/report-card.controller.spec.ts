import { ReportCardController } from './report-card.controller';
import type { ReportCardService } from './report-card.service';

interface ResLike {
  setHeader: jest.Mock;
  send: jest.Mock;
}

function makeRes(): ResLike {
  return {
    setHeader: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

describe('ReportCardController.preview', () => {
  it('sends the PNG buffer with image/png Content-Type and no-store cache', async () => {
    const buffer = Buffer.from('fake-png');
    const svc = {
      generatePng: jest.fn().mockResolvedValue({ buffer, data: {} }),
    } as unknown as ReportCardService;
    const ctrl = new ReportCardController(svc);
    const res = makeRes();

    await ctrl.preview('918888888001', res as never);

    expect(svc.generatePng).toHaveBeenCalledWith('918888888001');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.send).toHaveBeenCalledWith(buffer);
  });

  it('propagates errors from the service (e.g. NotFound) without writing headers', async () => {
    const svc = {
      generatePng: jest.fn().mockRejectedValue(new Error('User not found')),
    } as unknown as ReportCardService;
    const ctrl = new ReportCardController(svc);
    const res = makeRes();

    await expect(ctrl.preview('does-not-exist', res as never)).rejects.toThrow(
      'User not found',
    );
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('passes the userIdOrPhone param verbatim (no normalization)', async () => {
    const svc = {
      generatePng: jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), data: {} }),
    } as unknown as ReportCardService;
    const ctrl = new ReportCardController(svc);

    await ctrl.preview('11111111-2222-3333-4444-555555555555', makeRes() as never);
    expect(svc.generatePng).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
    );
  });
});
