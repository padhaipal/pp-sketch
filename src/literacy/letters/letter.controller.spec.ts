const mockSpanEnd = jest.fn();
const mockStartRootSpan = jest.fn(() => ({ end: mockSpanEnd }));
jest.mock('../../otel/otel', () => ({
  startRootSpan: (...args: unknown[]) => mockStartRootSpan(...args),
}));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { LetterController } from './letter.controller';
import { LetterService } from './letter.service';

type SvcMock = {
  create: jest.Mock;
  createBulk: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
};

function makeSvc(): SvcMock {
  return {
    create: jest.fn(),
    createBulk: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
}

function makeController(svc: SvcMock): LetterController {
  return new LetterController(svc as unknown as LetterService);
}

beforeEach(() => {
  mockSpanEnd.mockClear();
  mockStartRootSpan.mockClear();
});

describe('LetterController.createLetter', () => {
  it('validates body, delegates to service, ends span', async () => {
    const svc = makeSvc();
    const created = { id: 'u1', grapheme: 'क', media_metadata_id: null };
    svc.create.mockResolvedValue(created);
    const ctrl = makeController(svc);

    const result = await ctrl.createLetter({ grapheme: 'क' });

    expect(svc.create).toHaveBeenCalledWith({
      grapheme: 'क',
      media_metadata_id: undefined,
    });
    expect(result).toBe(created);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('still ends the span when the service throws', async () => {
    const svc = makeSvc();
    svc.create.mockRejectedValue(new Error('boom'));
    const ctrl = makeController(svc);

    await expect(ctrl.createLetter({ grapheme: 'क' })).rejects.toThrow('boom');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid body before calling the service', async () => {
    const svc = makeSvc();
    const ctrl = makeController(svc);

    await expect(ctrl.createLetter({})).rejects.toThrow(BadRequestException);
    expect(svc.create).not.toHaveBeenCalled();
    // span not started — validation happens before startRootSpan
    expect(mockStartRootSpan).not.toHaveBeenCalled();
  });
});

describe('LetterController.createLettersBulk', () => {
  it('delegates validated items to service and ends span', async () => {
    const svc = makeSvc();
    const out = [{ id: 'u1', grapheme: 'क', media_metadata_id: null }];
    svc.createBulk.mockResolvedValue(out);
    const ctrl = makeController(svc);

    const result = await ctrl.createLettersBulk({
      items: [{ grapheme: 'क' }],
    });

    expect(svc.createBulk).toHaveBeenCalledWith({
      items: [{ grapheme: 'क', media_metadata_id: undefined }],
    });
    expect(result).toBe(out);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('ends span even when service rejects', async () => {
    const svc = makeSvc();
    svc.createBulk.mockRejectedValue(new Error('nope'));
    const ctrl = makeController(svc);

    await expect(
      ctrl.createLettersBulk({ items: [{ grapheme: 'क' }] }),
    ).rejects.toThrow('nope');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});

describe('LetterController.updateLetter', () => {
  it('merges grapheme param into body and returns service result', async () => {
    const svc = makeSvc();
    const updated = { id: 'u1', grapheme: 'ख', media_metadata_id: null };
    svc.update.mockResolvedValue(updated);
    const ctrl = makeController(svc);

    const result = await ctrl.updateLetter('क', { new_grapheme: 'ख' });

    expect(svc.update).toHaveBeenCalledWith({
      grapheme: 'क',
      new_grapheme: 'ख',
      new_media_metadata_id: undefined,
    });
    expect(result).toBe(updated);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException when service returns null', async () => {
    const svc = makeSvc();
    svc.update.mockResolvedValue(null);
    const ctrl = makeController(svc);

    await expect(ctrl.updateLetter('क', { new_grapheme: 'ख' })).rejects.toThrow(
      NotFoundException,
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('ends span even when service rejects', async () => {
    const svc = makeSvc();
    svc.update.mockRejectedValue(new Error('boom'));
    const ctrl = makeController(svc);

    await expect(ctrl.updateLetter('क', { new_grapheme: 'ख' })).rejects.toThrow(
      'boom',
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});

describe('LetterController.deleteLetter', () => {
  it('returns void on successful delete and ends span', async () => {
    const svc = makeSvc();
    svc.delete.mockResolvedValue(true);
    const ctrl = makeController(svc);

    await expect(ctrl.deleteLetter('क')).resolves.toBeUndefined();
    expect(svc.delete).toHaveBeenCalledWith({ grapheme: 'क' });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException when service returns false', async () => {
    const svc = makeSvc();
    svc.delete.mockResolvedValue(false);
    const ctrl = makeController(svc);

    await expect(ctrl.deleteLetter('क')).rejects.toThrow(NotFoundException);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('translates BadRequestException from service into ConflictException', async () => {
    const svc = makeSvc();
    svc.delete.mockRejectedValue(new BadRequestException('fk violation'));
    const ctrl = makeController(svc);

    await expect(ctrl.deleteLetter('क')).rejects.toThrow(ConflictException);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-BadRequest service errors as-is', async () => {
    const svc = makeSvc();
    const err = new Error('boom');
    svc.delete.mockRejectedValue(err);
    const ctrl = makeController(svc);

    await expect(ctrl.deleteLetter('क')).rejects.toBe(err);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rethrows the NotFoundException it raised itself (not wrapped as conflict)', async () => {
    const svc = makeSvc();
    svc.delete.mockResolvedValue(false);
    const ctrl = makeController(svc);

    await expect(ctrl.deleteLetter('क')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
