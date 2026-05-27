import { BadRequestException } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

type SvcMock = {
  submitAnswer: jest.Mock;
  getAnswersForQuestion: jest.Mock;
  getCompletedSessionCount: jest.Mock;
  subscribeEmail: jest.Mock;
  createOrGetShareToken: jest.Mock;
  getShareData: jest.Mock;
  getMailingListSubscribers: jest.Mock;
};

function makeSvc(): SvcMock {
  return {
    submitAnswer: jest.fn(),
    getAnswersForQuestion: jest.fn(),
    getCompletedSessionCount: jest.fn(),
    subscribeEmail: jest.fn(),
    createOrGetShareToken: jest.fn(),
    getShareData: jest.fn(),
    getMailingListSubscribers: jest.fn(),
  };
}

function makeController(svc: SvcMock): DashboardController {
  return new DashboardController(svc as unknown as DashboardService);
}

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

describe('DashboardController.submitAnswer', () => {
  it('delegates body to service and returns { ok: true }', async () => {
    const svc = makeSvc();
    svc.submitAnswer.mockResolvedValue(undefined);
    const ctrl = makeController(svc);

    const body = { session_id: 's', question_index: 0, answer: 1 };
    const result = await ctrl.submitAnswer(body);

    expect(svc.submitAnswer).toHaveBeenCalledWith(body);
    expect(result).toEqual({ ok: true });
  });
});

describe('DashboardController.getAnswers', () => {
  it('parses question and forwards a UUID exclude_session', async () => {
    const svc = makeSvc();
    svc.getAnswersForQuestion.mockResolvedValue([1, 2, 3]);
    const ctrl = makeController(svc);

    const out = await ctrl.getAnswers('2', VALID_UUID);

    expect(svc.getAnswersForQuestion).toHaveBeenCalledWith(2, VALID_UUID);
    expect(out).toEqual({ answers: [1, 2, 3] });
  });

  it('passes undefined when exclude_session is missing', async () => {
    const svc = makeSvc();
    svc.getAnswersForQuestion.mockResolvedValue([]);
    const ctrl = makeController(svc);

    await ctrl.getAnswers('0');

    expect(svc.getAnswersForQuestion).toHaveBeenCalledWith(0, undefined);
  });

  it('drops exclude_session that does not match the UUID regex', async () => {
    const svc = makeSvc();
    svc.getAnswersForQuestion.mockResolvedValue([]);
    const ctrl = makeController(svc);

    await ctrl.getAnswers('0', 'not-a-uuid');

    expect(svc.getAnswersForQuestion).toHaveBeenCalledWith(0, undefined);
  });

  it('throws BadRequestException when question is not a number', async () => {
    const svc = makeSvc();
    const ctrl = makeController(svc);

    await expect(ctrl.getAnswers('abc')).rejects.toThrow(BadRequestException);
    expect(svc.getAnswersForQuestion).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when question < 0', async () => {
    const svc = makeSvc();
    const ctrl = makeController(svc);

    await expect(ctrl.getAnswers('-1')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when question >= NUM_QUIZ_QUESTIONS', async () => {
    const svc = makeSvc();
    const ctrl = makeController(svc);

    await expect(ctrl.getAnswers('5')).rejects.toThrow(BadRequestException);
  });

  it('accepts the boundary value question = NUM_QUIZ_QUESTIONS - 1', async () => {
    const svc = makeSvc();
    svc.getAnswersForQuestion.mockResolvedValue([]);
    const ctrl = makeController(svc);

    await ctrl.getAnswers('4');

    expect(svc.getAnswersForQuestion).toHaveBeenCalledWith(4, undefined);
  });
});

describe('DashboardController.getStats', () => {
  it('returns { completed } from the service', async () => {
    const svc = makeSvc();
    svc.getCompletedSessionCount.mockResolvedValue(11);
    const ctrl = makeController(svc);

    await expect(ctrl.getStats()).resolves.toEqual({ completed: 11 });
  });
});

describe('DashboardController.subscribe', () => {
  it('delegates and returns { ok: true }', async () => {
    const svc = makeSvc();
    svc.subscribeEmail.mockResolvedValue(undefined);
    const ctrl = makeController(svc);

    const body = { email: 'a@b.com', name: 'A' };
    const out = await ctrl.subscribe(body);

    expect(svc.subscribeEmail).toHaveBeenCalledWith(body);
    expect(out).toEqual({ ok: true });
  });
});

describe('DashboardController.createShareToken', () => {
  it('returns { token } from service.createOrGetShareToken', async () => {
    const svc = makeSvc();
    svc.createOrGetShareToken.mockResolvedValue('tok-xyz');
    const ctrl = makeController(svc);

    const out = await ctrl.createShareToken({ session_id: VALID_UUID });

    expect(svc.createOrGetShareToken).toHaveBeenCalledWith(VALID_UUID);
    expect(out).toEqual({ token: 'tok-xyz' });
  });
});

describe('DashboardController.getShare', () => {
  it('returns share data for a valid token', async () => {
    const svc = makeSvc();
    const data = { answers: [{ question_index: 0, answer: 1 }], completed: 7 };
    svc.getShareData.mockResolvedValue(data);
    const ctrl = makeController(svc);

    const out = await ctrl.getShare('ABCdef_-12');

    expect(svc.getShareData).toHaveBeenCalledWith('ABCdef_-12');
    expect(out).toBe(data);
  });

  it('rejects tokens with characters outside [A-Za-z0-9_-]', async () => {
    const svc = makeSvc();
    const ctrl = makeController(svc);

    await expect(ctrl.getShare('bad!token')).rejects.toThrow(
      BadRequestException,
    );
    expect(svc.getShareData).not.toHaveBeenCalled();
  });

  it('rejects empty token', async () => {
    const svc = makeSvc();
    const ctrl = makeController(svc);

    await expect(ctrl.getShare('')).rejects.toThrow(BadRequestException);
  });

  it('rejects tokens longer than 64 chars', async () => {
    const svc = makeSvc();
    const ctrl = makeController(svc);

    await expect(ctrl.getShare('a'.repeat(65))).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('DashboardController.getSubscribers', () => {
  it('returns subscribers array and its count', async () => {
    const svc = makeSvc();
    const subs = [
      { email: 'a@b.com', name: 'A', created_at: new Date() },
      { email: 'c@d.com', name: null, created_at: new Date() },
    ];
    svc.getMailingListSubscribers.mockResolvedValue(subs);
    const ctrl = makeController(svc);

    const out = await ctrl.getSubscribers();

    expect(out).toEqual({ subscribers: subs, count: 2 });
  });

  it('returns count=0 for an empty subscriber list', async () => {
    const svc = makeSvc();
    svc.getMailingListSubscribers.mockResolvedValue([]);
    const ctrl = makeController(svc);

    await expect(ctrl.getSubscribers()).resolves.toEqual({
      subscribers: [],
      count: 0,
    });
  });
});
