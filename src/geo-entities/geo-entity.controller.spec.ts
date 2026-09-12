import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GeoEntityController } from './geo-entity.controller';
import type { GeoEntityService } from './geo-entity.service';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

function makeController(
  overrides: Partial<Record<keyof GeoEntityService, jest.Mock>> = {},
) {
  const svc = {
    getById: jest.fn().mockResolvedValue({ id: ID, type: 'block', name: 'B' }),
    ancestors: jest.fn().mockResolvedValue([{ id: ID2, type: 'district' }]),
    descendants: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
    search: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return {
    ctrl: new GeoEntityController(svc as unknown as GeoEntityService),
    svc,
  };
}

describe('GeoEntityController.search', () => {
  it('passes q and a validated type; blank type means all types', async () => {
    const { ctrl, svc } = makeController();
    await ctrl.search('kup', 'district');
    expect(svc.search).toHaveBeenCalledWith('kup', 'district');
    await ctrl.search('kup', '');
    expect(svc.search).toHaveBeenLastCalledWith('kup', null);
    await ctrl.search(undefined, undefined);
    expect(svc.search).toHaveBeenLastCalledWith('', null);
  });

  it('rejects an unknown type', async () => {
    const { ctrl } = makeController();
    await expect(ctrl.search('x', 'village')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('GeoEntityController.getOne', () => {
  it('returns the entity with its ancestors', async () => {
    const { ctrl } = makeController();
    await expect(ctrl.getOne(ID)).resolves.toEqual({
      id: ID,
      type: 'block',
      name: 'B',
      ancestors: [{ id: ID2, type: 'district' }],
    });
  });

  it('404s for an unknown id and 400s for a non-uuid', async () => {
    const { ctrl } = makeController({
      getById: jest.fn().mockResolvedValue(null),
    });
    await expect(ctrl.getOne(ID)).rejects.toThrow(NotFoundException);
    await expect(ctrl.getOne('not-a-uuid')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('GeoEntityController.descendants', () => {
  it('validates type, cursor and limit and forwards them', async () => {
    const { ctrl, svc } = makeController();
    await ctrl.descendants(ID, 'school', ID2, '50');
    expect(svc.descendants).toHaveBeenCalledWith(ID, 'school', {
      cursor: ID2,
      limit: 50,
    });
    await ctrl.descendants(ID, 'school', '', undefined);
    expect(svc.descendants).toHaveBeenLastCalledWith(ID, 'school', {
      cursor: null,
      limit: 100,
    });
  });

  it.each([
    ['missing type', [ID, undefined, undefined, undefined]],
    ['bad cursor', [ID, 'school', 'x', undefined]],
    ['limit 0', [ID, 'school', undefined, '0']],
    ['limit 501', [ID, 'school', undefined, '501']],
    ['limit text', [ID, 'school', undefined, 'lots']],
  ])('400s on %s', async (_label, args) => {
    const { ctrl } = makeController();
    await expect(
      ctrl.descendants(...(args as [string, string?, string?, string?])),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s when the root does not exist', async () => {
    const { ctrl } = makeController({
      getById: jest.fn().mockResolvedValue(null),
    });
    await expect(ctrl.descendants(ID, 'school')).rejects.toThrow(
      NotFoundException,
    );
  });
});
