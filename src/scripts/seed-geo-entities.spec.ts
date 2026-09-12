import { Readable } from 'stream';
import {
  BATCH_SIZE,
  DEFAULT_SCHOOLS_URL,
  Pass1Accumulator,
  SCHOOL_ATTRIBUTE_KEYS,
  SCHOOL_STATUS_MAP,
  SUSPECT_GROUP_SIZE,
  UnmappedStatusError,
  buildLevelRows,
  buildSchoolRow,
  checkRowFormat,
  classRange,
  coordinateKey,
  findMergeCycleBreaks,
  formatReport,
  managementGroup,
  mapSchoolStatus,
  mergeTargetSchoolId,
  parseArgs,
  parseManifest,
  parseStatusMap,
  resolveCoordinates,
  runSeed,
  schoolAttributes,
  streamCsvRows,
  type SeedDeps,
  type SourceRow,
} from './seed-geo-entities';
import type { GeoEntityUpsertRow } from '../geo-entities/geo-entity.dto';

// ─── Fixture: 60 register rows across 2 states / 3 districts / 4 blocks ──────

const HEADER = [
  'udise_code',
  'school_name',
  'state_code',
  'state',
  'district_code',
  'district',
  'block_code',
  'block',
  'cluster',
  'category',
  'latitude',
  'longitude',
  'schoolId',
  'schoolStatus',
  'schoolStatusName',
  'schIdMerged',
  'classFrm',
  'classTo',
  'schBroadMgmtId',
  'schMgmtDesc',
  'clusterCd',
  'lgdStateId',
  'lgdblockId',
  'coord_source',
];

interface Spec {
  udise: string;
  name?: string;
  state?: string;
  district?: string;
  block?: string;
  cluster?: string;
  clusterCd?: string;
  category?: string;
  lat?: string;
  lng?: string;
  schoolId?: string;
  statusName?: string;
  schoolStatus?: string;
  merged?: string;
  classFrm?: string;
  classTo?: string;
  mgmt?: string;
}

const STATE_NAMES: Record<string, string> = {
  '01': 'JAMMU & KASHMIR',
  '02': 'HIMACHAL PRADESH',
  '90': 'KENDRIYA VIDYALAYA SANGATHAN',
};
const DISTRICT_NAMES: Record<string, string> = {
  '0101': 'KUPWARA',
  '0102': 'BARAMULLA',
  '0201': 'CHAMBA',
  '9001': 'KVS REGION',
};
const BLOCK_NAMES: Record<string, string> = {
  '010101': 'KUPWARA',
  '010102': 'HANDWARA',
  '010201': 'BARAMULLA',
  '020101': 'CHAMBA',
  '900101': 'KVS BLOCK',
};

function row(spec: Spec): SourceRow {
  const state = spec.state ?? spec.udise.slice(0, 2);
  const district = spec.district ?? spec.udise.slice(0, 4);
  const block = spec.block ?? spec.udise.slice(0, 6);
  return {
    udise_code: spec.udise,
    school_name: spec.name ?? `SCHOOL ${spec.udise}`,
    state_code: state,
    state: STATE_NAMES[state] ?? `STATE ${state}`,
    district_code: district,
    district: DISTRICT_NAMES[district] ?? `DISTRICT ${district}`,
    block_code: block,
    block: BLOCK_NAMES[block] ?? `BLOCK ${block}`,
    cluster: spec.cluster ?? 'MS CLUSTER',
    category: spec.category ?? 'Primary',
    // Unique per udise by default so only the explicit shared-coordinate
    // groups trigger the village-centroid rule.
    latitude: spec.lat ?? `33.${spec.udise.slice(-5)}`,
    longitude: spec.lng ?? `73.${spec.udise.slice(-5)}`,
    schoolId: spec.schoolId ?? `1${spec.udise.slice(5)}`,
    schoolStatus: spec.schoolStatus ?? '0',
    schoolStatusName: spec.statusName ?? 'Operational',
    schIdMerged: spec.merged ?? '0',
    classFrm: spec.classFrm ?? '1',
    classTo: spec.classTo ?? '5',
    schBroadMgmtId: spec.mgmt ?? '1',
    schMgmtDesc:
      spec.mgmt === '3' ? 'Private Unaided' : 'Department of Education',
    clusterCd: spec.clusterCd ?? `${block}0001`,
    lgdStateId: state === '01' ? '1' : state === '02' ? '2' : '',
    lgdblockId: `${block}9`,
    coord_source: 'kys_by_year',
  };
}

const STATUS_MAP = {
  ...SCHOOL_STATUS_MAP,
  Closed: 'closed' as const,
  Merged: 'merged' as const,
};

function fixture(): SourceRow[] {
  const rows: SourceRow[] = [];
  // 40 plain operational schools across the four real blocks, distinct coords.
  const blocks = ['010101', '010102', '010201', '020101'];
  for (let i = 0; i < 40; i++) {
    const block = blocks[i % 4];
    rows.push(
      row({
        udise: `${block}${String(100 + i).padStart(5, '0')}`,
        lat: `34.${100 + i}`,
        lng: `74.${100 + i}`,
      }),
    );
  }
  // 41–44: four operational schools sharing one coordinate (village centroid).
  for (let i = 0; i < 4; i++) {
    rows.push(row({ udise: `0101010020${i}`, lat: '34.5', lng: '74.5' }));
  }
  // 45–47: three sharing a coordinate — below the threshold, kept as-is.
  for (let i = 0; i < 3; i++) {
    rows.push(row({ udise: `0101010030${i}`, lat: '34.6', lng: '74.6' }));
  }
  // 48: one more plain school in the HP block.
  rows.push(row({ udise: '02010100300', lat: '32.1', lng: '76.1' }));
  // 48: 10-digit school code → format skip.
  rows.push(row({ udise: '0101010040' }));
  // 49: stale merged pointer on an OPERATIONAL row → never linked.
  rows.push(
    row({ udise: '01010100500', merged: '1000100', schoolId: '1000500' }),
  );
  // 50: closed, self-reference → not linked.
  rows.push(
    row({
      udise: '01010100501',
      statusName: 'Closed',
      schoolStatus: '1',
      schoolId: '1000501',
      merged: '1000501',
    }),
  );
  // 51–52: closed 2-node cycle.
  rows.push(
    row({
      udise: '01010100502',
      statusName: 'Merged',
      schoolStatus: '2',
      schoolId: '1000502',
      merged: '1000503',
    }),
  );
  rows.push(
    row({
      udise: '01010100503',
      statusName: 'Merged',
      schoolStatus: '2',
      schoolId: '1000503',
      merged: '1000502',
    }),
  );
  // 53: blank class range, category Primary with Upper Primary → estimated 1–8.
  rows.push(
    row({
      udise: '01010100504',
      classFrm: '',
      classTo: '',
      category: 'Primary with Upper Primary',
    }),
  );
  // 54: school whose block is absent from the seeded blocks (checked in
  // buildSchoolRow with a block map that omits 010199).
  rows.push(row({ udise: '01019900001', block: '010199' }));
  // 55: clusterCd that is a name rather than a code.
  rows.push(row({ udise: '01010100505', clusterCd: 'MS DELINA (A)' }));
  // 56: private management, second cluster spelling for the same clusterCd.
  rows.push(row({ udise: '01010100506', mgmt: '3', cluster: 'M.S. CLUSTER' }));
  // 57: pseudo-state (KVS) → skipped by the manifest rule.
  rows.push(
    row({
      udise: '90010100001',
      state: '90',
      district: '9001',
      block: '900101',
    }),
  );
  // 58: closed with a resolvable merge target (row 0).
  rows.push(
    row({
      udise: '01010100507',
      statusName: 'Closed',
      schoolStatus: '1',
      schoolId: '1000507',
      merged: rows[0].schoolId,
    }),
  );
  // 59: unmapped status (only used by the failure test via a separate map).
  rows.push(
    row({
      udise: '01010100508',
      statusName: 'Sanctioned But Not Operational',
      schoolStatus: '4',
    }),
  );
  expect(rows).toHaveLength(60);
  return rows;
}

const MANIFEST_CSV = [
  'type,code,name,file,bytes,vertices',
  'country,IN,India,boundaries/country/IN.geojson,1,1',
  'state,01,Jammu & Kashmir,boundaries/state/01.geojson,1,1',
  'state,02,Himachal Pradesh,boundaries/state/02.geojson,1,1',
  'district,0101,Kupwara,boundaries/district/0101.geojson,1,1',
  'district,0102,Baramulla,boundaries/district/0102.geojson,1,1',
  // 0201 deliberately absent → has_boundary false.
].join('\n');

function toCsv(rows: SourceRow[]): string {
  const esc = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [
    HEADER.join(','),
    ...rows.map((r) => HEADER.map((h) => esc(r[h] ?? '')).join(',')),
  ].join('\n');
}

const PULLED_AT = new Date('2026-09-04T23:13:42Z');

// ─── Row rules ───────────────────────────────────────────────────────────────

describe('checkRowFormat', () => {
  it('accepts a well-formed row and rejects a 10-digit school code', () => {
    expect(checkRowFormat(row({ udise: '01010100101' }))).toBeNull();
    expect(checkRowFormat(row({ udise: '0101010040' }))).toMatch(/udise_code/);
  });

  it('catches a shifted row whose field count survived a stray comma', () => {
    const shifted = { ...row({ udise: '01010100101' }), state_code: 'JAMMU' };
    expect(checkRowFormat(shifted)).toMatch(/state_code/);
    expect(
      checkRowFormat({ ...row({ udise: '01010100101' }), block_code: '1' }),
    ).toMatch(/block_code/);
  });
});

describe('status mapping', () => {
  it('maps Operational and throws UnmappedStatusError otherwise', () => {
    expect(mapSchoolStatus('Operational', SCHOOL_STATUS_MAP)).toBe(
      'operational',
    );
    expect(() =>
      mapSchoolStatus('Sanctioned But Not Operational', SCHOOL_STATUS_MAP),
    ).toThrow(UnmappedStatusError);
  });

  it('parseStatusMap validates the enum values', () => {
    expect(parseStatusMap('{"Closed":"closed"}')).toEqual({ Closed: 'closed' });
    expect(() => parseStatusMap('{"Closed":"shut"}')).toThrow(/is not one of/);
    expect(() => parseStatusMap('[]')).toThrow(/JSON object/);
  });
});

describe('managementGroup / classRange', () => {
  it('maps 1 and 3, everything else to other', () => {
    expect(managementGroup('1')).toBe('government');
    expect(managementGroup('3')).toBe('private');
    expect(managementGroup('4')).toBe('other');
    expect(managementGroup('9')).toBe('other');
    expect(managementGroup('')).toBe('other');
  });

  it('uses classFrm/classTo when present, else estimates from category', () => {
    expect(
      classRange(row({ udise: '01010100101', classFrm: '6', classTo: '8' })),
    ).toEqual({
      class_from: 6,
      class_to: 8,
      estimated: false,
    });
    expect(
      classRange(
        row({
          udise: '01010100101',
          classFrm: '',
          classTo: '',
          category: 'Primary with Upper Primary',
        }),
      ),
    ).toEqual({ class_from: 1, class_to: 8, estimated: true });
    expect(
      classRange(
        row({
          udise: '01010100101',
          classFrm: '',
          classTo: '',
          category: 'Pre-Primary',
        }),
      ),
    ).toEqual({ class_from: null, class_to: null, estimated: true });
    expect(
      classRange(
        row({
          udise: '01010100101',
          classFrm: '',
          classTo: '',
          category: 'Something',
        }),
      ),
    ).toEqual({ class_from: null, class_to: null, estimated: true });
  });
});

describe('coordinates', () => {
  it('coordinateKey ignores blank, non-numeric, 0,0 and out-of-range values', () => {
    expect(
      coordinateKey(row({ udise: '01010100101', lat: '', lng: '' })),
    ).toBeNull();
    expect(
      coordinateKey(row({ udise: '01010100101', lat: 'x', lng: '1' })),
    ).toBeNull();
    expect(
      coordinateKey(row({ udise: '01010100101', lat: '0', lng: '0' })),
    ).toBeNull();
    expect(
      coordinateKey(row({ udise: '01010100101', lat: '91', lng: '0' })),
    ).toBeNull();
    expect(
      coordinateKey(row({ udise: '01010100101', lat: '34.5', lng: '74.5' })),
    ).toBe('34.5,74.5');
  });

  it(`flags a group of ${SUSPECT_GROUP_SIZE} as a village centroid, leaves a group of 3 alone`, () => {
    const counts = new Map([
      ['34.5,74.5', 4],
      ['34.6,74.6', 3],
    ]);
    expect(
      resolveCoordinates(
        row({ udise: '01010100101', lat: '34.5', lng: '74.5' }),
        counts,
      ),
    ).toEqual({
      lat: 34.5,
      lng: 74.5,
      suspect: true,
    });
    expect(
      resolveCoordinates(
        row({ udise: '01010100101', lat: '34.6', lng: '74.6' }),
        counts,
      ),
    ).toEqual({
      lat: 34.6,
      lng: 74.6,
      suspect: false,
    });
  });
});

describe('schoolAttributes', () => {
  it('keeps only the allowlisted keys plus derived flags, dropping blanks', () => {
    const r = row({ udise: '01010100505', clusterCd: 'MS DELINA (A)' });
    const attrs = schoolAttributes(r, {
      suspect_lat: 1,
      suspect_lng: 2,
      class_range_estimated: true,
    });
    for (const key of Object.keys(attrs)) {
      expect([
        ...SCHOOL_ATTRIBUTE_KEYS,
        'suspect_lat',
        'suspect_lng',
        'class_range_estimated',
      ]).toContain(key);
    }
    expect(attrs.clusterCd).toBe('MS DELINA (A)');
    expect(attrs.schoolId).toBe(r.schoolId);
    expect(attrs).not.toHaveProperty('school_name');
    expect(attrs).not.toHaveProperty('lgdblockId');
    expect(schoolAttributes({ ...r, schIdMerged: '' }, {})).not.toHaveProperty(
      'schIdMerged',
    );
  });
});

describe('merge pointers', () => {
  it('mergeTargetSchoolId: only non-operational rows, never 0/blank/self', () => {
    expect(
      mergeTargetSchoolId(
        row({ udise: '01010100500', merged: '1000100' }),
        'operational',
      ),
    ).toBeNull();
    expect(
      mergeTargetSchoolId(
        row({ udise: '01010100501', schoolId: '1000501', merged: '1000501' }),
        'closed',
      ),
    ).toBeNull();
    expect(
      mergeTargetSchoolId(row({ udise: '01010100501', merged: '0' }), 'closed'),
    ).toBeNull();
    expect(
      mergeTargetSchoolId(
        row({ udise: '01010100507', merged: '1000100' }),
        'closed',
      ),
    ).toBe('1000100');
  });

  it('findMergeCycleBreaks nulls every member of an all-closed 2-node cycle and leaves chains alone', () => {
    const breaks = findMergeCycleBreaks([
      { id: 'a', merged_into_id: 'b', status: 'merged' },
      { id: 'b', merged_into_id: 'a', status: 'merged' },
      { id: 'c', merged_into_id: 'd', status: 'closed' }, // chain c → d → e
      { id: 'd', merged_into_id: 'e', status: 'closed' },
    ]);
    expect(breaks.sort()).toEqual(['a', 'b']);
  });

  it('findMergeCycleBreaks prefers the operational member of a cycle', () => {
    const breaks = findMergeCycleBreaks([
      { id: 'a', merged_into_id: 'b', status: 'operational' },
      { id: 'b', merged_into_id: 'c', status: 'closed' },
      { id: 'c', merged_into_id: 'a', status: 'closed' },
    ]);
    expect(breaks).toEqual(['a']);
  });
});

describe('parseManifest / parseArgs', () => {
  it('parseManifest buckets codes by type', () => {
    const m = parseManifest(MANIFEST_CSV);
    expect([...m.states]).toEqual(['01', '02']);
    expect([...m.districts]).toEqual(['0101', '0102']);
    expect([...m.country]).toEqual(['IN']);
    expect(() => parseManifest('a,b\n1,2')).toThrow(/type and code/);
  });

  it('parseArgs: defaults, --status-map inline and file, --dry-run, required --pulled-at', () => {
    const env = { DASHBOARD_PUBLIC_URL: 'https://dash.example/' };
    const args = parseArgs(
      ['--pulled-at', '2026-09-04T00:00:00Z', '--dry-run'],
      env,
      () => '',
    );
    expect(args).toEqual({
      schoolsUrl: DEFAULT_SCHOOLS_URL,
      manifest: 'https://dash.example/boundaries/boundaries_manifest.csv',
      statusMap: { Operational: 'operational' },
      pulledAt: new Date('2026-09-04T00:00:00Z'),
      dryRun: true,
    });
    expect(
      parseArgs(
        [
          '--pulled-at=2026-09-04',
          '--status-map={"Closed":"closed"}',
          '--manifest',
          '/tmp/m.csv',
        ],
        {},
        () => '',
      ).statusMap,
    ).toEqual({ Operational: 'operational', Closed: 'closed' });
    expect(
      parseArgs(
        [
          '--pulled-at',
          '2026-09-04',
          '--status-map',
          'map.json',
          '--manifest',
          'x',
        ],
        {},
        (p) => {
          expect(p).toBe('map.json');
          return '{"Merged":"merged"}';
        },
      ).statusMap.Merged,
    ).toBe('merged');
    expect(() => parseArgs([], env, () => '')).toThrow(/--pulled-at/);
    expect(() =>
      parseArgs(['--pulled-at', '2026-09-04'], {}, () => ''),
    ).toThrow(/--manifest/);
  });
});

// ─── CSV streaming ───────────────────────────────────────────────────────────

describe('streamCsvRows', () => {
  it('skips a row with an unescaped comma, counts it, and keeps streaming', async () => {
    const good = row({ udise: '01010100101' });
    const after = row({ udise: '01010100102' });
    const bad = HEADER.map((h) =>
      h === 'school_name' ? 'BAD, NAME' : (good[h] ?? ''),
    ).join(',');
    const csv = [
      HEADER.join(','),
      toCsv([good]).split('\n')[1],
      bad,
      toCsv([after]).split('\n')[1],
    ].join('\n');
    const skipped: Error[] = [];
    const rows: SourceRow[] = [];
    for await (const r of streamCsvRows(Readable.from([csv]), (e) =>
      skipped.push(e),
    ))
      rows.push(r);
    expect(rows.map((r) => r.udise_code)).toEqual([
      '01010100101',
      '01010100102',
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].message).toMatch(/Invalid Record Length/);
  });
});

// ─── Pass 1 over the fixture ─────────────────────────────────────────────────

describe('Pass1Accumulator over the 60-row fixture', () => {
  it('validates, counts and reports', () => {
    const acc = new Pass1Accumulator(parseManifest(MANIFEST_CSV), STATUS_MAP);
    acc.recordParseSkip();
    for (const r of fixture()) acc.add(r);
    const report = acc.finish();

    expect(report.rows).toBe(60);
    expect(report.skippedParse).toBe(1);
    expect(report.skippedFormat).toBe(1); // the 10-digit code
    expect(report.skippedPseudoState).toBe(1); // KVS
    expect(report.states).toBe(2);
    expect(report.districts).toBe(3);
    expect(report.blocks).toBe(5); // four real + the absent 010199
    expect(report.schools).toBe(58);
    expect(report.unmappedStatuses.get('Sanctioned But Not Operational')).toBe(
      1,
    );
    expect(report.errors.some((e) => /unmapped schoolStatusName/.test(e))).toBe(
      true,
    );
    expect(report.clustersSpanningBlocks).toBe(0);
    expect(report.clusterCdLengths.get(10)).toBeGreaterThan(50);
    expect(report.clusterCdLengths.get('MS DELINA (A)'.length)).toBe(1);
    expect(report.statusPairs.get('0|Operational')).toBeGreaterThan(50);
    expect(report.managementPairs.get('3|Private Unaided')).toBe(1);
    expect(report.meanAttributesBytes).toBeGreaterThan(50);
    expect(acc.coordCounts.get('34.5,74.5')).toBe(4);
    expect(acc.coordCounts.get('34.6,74.6')).toBe(3);
    expect(formatReport(report)).toMatch(/VALIDATION FAILED/);
  });

  it('passes once the status map covers every label, and resolves names by majority', () => {
    const acc = new Pass1Accumulator(parseManifest(MANIFEST_CSV), {
      ...STATUS_MAP,
      'Sanctioned But Not Operational': 'sanctioned_not_operational',
    });
    for (const r of fixture()) acc.add(r);
    const report = acc.finish();
    expect(report.errors).toEqual([]);
    expect(formatReport(report)).toMatch(/validation passed/);
    const states = acc.resolved(acc.states);
    expect(states.get('01')).toEqual({
      name: 'JAMMU & KASHMIR',
      parentCode: null,
      lgdCode: '1',
    });
    const blocks = acc.resolved(acc.blocks);
    expect(blocks.get('010101')?.parentCode).toBe('0101');
  });

  it('fails when a district appears under two states', () => {
    const acc = new Pass1Accumulator(parseManifest(MANIFEST_CSV), STATUS_MAP);
    acc.add(row({ udise: '01010100101' }));
    acc.add(row({ udise: '02010100101', district: '0101' }));
    expect(acc.finish().errors.join('\n')).toMatch(
      /district 0101 appears under 2 states/,
    );
  });
});

// ─── Pass 2 rows ─────────────────────────────────────────────────────────────

describe('buildLevelRows / buildSchoolRow', () => {
  const manifest = parseManifest(MANIFEST_CSV);

  it('has_boundary comes from the manifest, never hardcoded', () => {
    const acc = new Pass1Accumulator(manifest, STATUS_MAP);
    for (const r of fixture()) acc.add(r);
    const stateIds = new Map([
      ['01', 's1'],
      ['02', 's2'],
    ]);
    const { rows } = buildLevelRows(
      'district',
      acc.resolved(acc.districts),
      stateIds,
      manifest,
      PULLED_AT,
    );
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.get('0101')?.has_boundary).toBe(true);
    expect(byCode.get('0201')?.has_boundary).toBe(false);
    expect(byCode.get('0201')?.parent_id).toBe('s2');
    expect(byCode.get('0101')?.source).toBe('kys_by_region');
  });

  it('skips a level row whose parent was not seeded', () => {
    const { rows, missingParents } = buildLevelRows(
      'block',
      new Map([['010199', { name: 'X', parentCode: '0199', lgdCode: null }]]),
      new Map([['0101', 'd1']]),
      manifest,
      PULLED_AT,
    );
    expect(rows).toEqual([]);
    expect(missingParents).toEqual(['block 010199 → 0199']);
  });

  it('builds a school row: parent by listed block_code, coords, class range, attributes allowlist', () => {
    const blockIds = new Map([['010101', 'b1']]);
    const counts = new Map([['34.5,74.5', 4]]);
    const plain = buildSchoolRow(
      row({ udise: '01010100101', lat: '34.1', lng: '74.1' }),
      blockIds,
      counts,
      STATUS_MAP,
      PULLED_AT,
    )!;
    expect(plain.parent_id).toBe('b1');
    expect(plain.lat).toBe(34.1);
    expect(plain.status).toBe('operational');
    expect(plain.management_group).toBe('government');
    expect(plain.class_from).toBe(1);
    expect(plain.attributes).toEqual({
      schoolId: '1100101',
      schIdMerged: '0',
      clusterCd: '0101010001',
      cluster: 'MS CLUSTER',
      schoolStatus: '0',
      schoolStatusName: 'Operational',
      schBroadMgmtId: '1',
      coord_source: 'kys_by_year',
    });
    expect(plain.source).toBe('kys_by_year');

    const centroid = buildSchoolRow(
      row({ udise: '01010100201', lat: '34.5', lng: '74.5' }),
      blockIds,
      counts,
      STATUS_MAP,
      PULLED_AT,
    )!;
    expect(centroid.lat).toBeNull();
    expect(centroid.attributes.suspect_lat).toBe(34.5);
    expect(centroid.attributes.suspect_lng).toBe(74.5);

    const estimated = buildSchoolRow(
      row({
        udise: '01010100504',
        classFrm: '',
        classTo: '',
        category: 'Primary with Upper Primary',
      }),
      blockIds,
      counts,
      STATUS_MAP,
      PULLED_AT,
    )!;
    expect([estimated.class_from, estimated.class_to]).toEqual([1, 8]);
    expect(estimated.attributes.class_range_estimated).toBe(true);
  });

  it('returns null for a school whose block is absent, and throws on an unmapped status', () => {
    const blockIds = new Map([['010101', 'b1']]);
    expect(
      buildSchoolRow(
        row({ udise: '01019900001', block: '010199' }),
        blockIds,
        new Map(),
        STATUS_MAP,
        PULLED_AT,
      ),
    ).toBeNull();
    expect(() =>
      buildSchoolRow(
        row({
          udise: '01010100508',
          statusName: 'Sanctioned But Not Operational',
        }),
        blockIds,
        new Map(),
        STATUS_MAP,
        PULLED_AT,
      ),
    ).toThrow(UnmappedStatusError);
  });

  it('a name-valued clusterCd lands in attributes and changes nothing else', () => {
    const blockIds = new Map([['010101', 'b1']]);
    const built = buildSchoolRow(
      row({ udise: '01010100505', clusterCd: 'MS DELINA (A)' }),
      blockIds,
      new Map(),
      STATUS_MAP,
      PULLED_AT,
    )!;
    expect(built.parent_id).toBe('b1');
    expect(built.attributes.clusterCd).toBe('MS DELINA (A)');
  });
});

// ─── Orchestrator with in-memory deps ────────────────────────────────────────

function makeDeps(csv: string, overrides: Partial<SeedDeps> = {}) {
  const upserts: GeoEntityUpsertRow[][] = [];
  const log: string[] = [];
  const ids = new Map<string, string>();
  let txDepth = 0;
  const txLog: string[] = [];
  const deps: SeedDeps = {
    log: (m) => log.push(m),
    openRows: () => Readable.from([csv]),
    readManifest: async () => MANIFEST_CSV,
    upsertBatch: async (rows) => {
      expect(txDepth).toBe(1); // every write happens inside a transaction
      upserts.push(rows);
      for (const r of rows)
        ids.set(`${r.type}:${r.code}`, `${r.type}-${r.code}`);
    },
    transaction: async (fn) => {
      txDepth += 1;
      txLog.push('begin');
      try {
        return await fn();
      } finally {
        txDepth -= 1;
        txLog.push('commit');
      }
    },
    codeMap: async (type) =>
      new Map(
        [...ids]
          .filter(([k]) => k.startsWith(`${type}:`))
          .map(([k, v]) => [k.slice(type.length + 1), v]),
      ),
    linkMergedSchools: jest.fn().mockResolvedValue(2),
    mergeEdges: jest.fn().mockResolvedValue([
      {
        id: 'school-01010100502',
        merged_into_id: 'school-01010100503',
        status: 'merged',
      },
      {
        id: 'school-01010100503',
        merged_into_id: 'school-01010100502',
        status: 'merged',
      },
    ]),
    clearMergedInto: jest.fn().mockResolvedValue(undefined),
    updateBlockCoordinates: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (/GROUP BY type, status/.test(sql))
        return [{ type: 'school', status: 'operational', n: 1 }];
      if (sql.includes('block-coords:districts'))
        return [{ id: 'district-0101' }];
      if (sql.includes('block-coords:blocks'))
        return params[0] === 'district-0101' ? [{ id: 'block-010101' }] : [];
      if (sql.includes('block-coords:schools'))
        return params[0] === 'district-0101'
          ? [
              { block_id: 'block-010101', lat: 34.1, lng: 74.1 },
              { block_id: 'block-010101', lat: 34.2, lng: 74.2 },
            ]
          : [];
      return [{ n: 0 }];
    }),
    ...overrides,
  };
  return { deps, upserts, log, txLog };
}

const FULL_STATUS_MAP = {
  ...STATUS_MAP,
  'Sanctioned But Not Operational': 'sanctioned_not_operational' as const,
};

describe('runSeed', () => {
  it('--dry-run validates, prints the report and writes nothing', async () => {
    const { deps, upserts, log } = makeDeps(toCsv(fixture()));
    await runSeed(deps, {
      schoolsUrl: 'x',
      manifest: 'm',
      statusMap: FULL_STATUS_MAP,
      pulledAt: PULLED_AT,
      dryRun: true,
    });
    expect(upserts).toEqual([]);
    expect(log.join('\n')).toMatch(/validation passed/);
    expect(log.join('\n')).toMatch(/dry run — stopping/);
  });

  it('fails validation (no writes) while a status is unmapped', async () => {
    const { deps, upserts } = makeDeps(toCsv(fixture()));
    await expect(
      runSeed(deps, {
        schoolsUrl: 'x',
        manifest: 'm',
        statusMap: STATUS_MAP,
        pulledAt: PULLED_AT,
        dryRun: false,
      }),
    ).rejects.toThrow(/validation failed/);
    expect(upserts).toEqual([]);
  });

  it('seeds country → states → districts → blocks → schools, each level in its own transaction, then links and breaks cycles', async () => {
    const { deps, upserts, log, txLog } = makeDeps(toCsv(fixture()));
    await runSeed(deps, {
      schoolsUrl: 'x',
      manifest: 'm',
      statusMap: FULL_STATUS_MAP,
      pulledAt: PULLED_AT,
      dryRun: false,
    });

    expect(upserts.map((b) => b[0].type)).toEqual([
      'country',
      'state',
      'district',
      'block',
      'school',
    ]);
    expect(upserts[0]).toEqual([
      expect.objectContaining({
        type: 'country',
        code: 'IN',
        name: 'India',
        has_boundary: true,
        parent_id: null,
      }),
    ]);
    expect(upserts[1].map((r) => r.code).sort()).toEqual(['01', '02']);
    expect(upserts[1].every((r) => r.parent_id === 'country-IN')).toBe(true);
    expect(upserts[3].map((r) => r.code).sort()).toEqual([
      '010101',
      '010102',
      '010199',
      '010201',
      '020101',
    ]);
    // 60 rows − 10-digit code − KVS row = 58 schools, one of which has no
    // seeded block? No: 010199 IS seeded (it appears in the register), so
    // every valid school lands; the 4-school centroid rows carry null coords.
    const schools = upserts[4];
    expect(schools).toHaveLength(58);
    expect(schools.every((r) => r.parent_id?.startsWith('block-'))).toBe(true);
    expect(schools.filter((r) => r.lat === null)).toHaveLength(4);
    expect(schools.find((r) => r.code === '01010100507')?.status).toBe(
      'closed',
    );
    // Five level transactions (country, state, district, block, school)
    // plus one block-coordinates transaction for the fixture's one district.
    expect(txLog.filter((t) => t === 'begin')).toHaveLength(6);
    expect(deps.linkMergedSchools).toHaveBeenCalledTimes(1);
    expect(deps.clearMergedInto).toHaveBeenCalledWith(
      expect.arrayContaining(['school-01010100502', 'school-01010100503']),
    );
    expect(log.join('\n')).toMatch(/school: 58 rows upserted/);
    expect(log.join('\n')).toMatch(/final counts:/);
    // Block label points are the seed's final step, after merge pointers:
    // the median of the two fixture schools.
    expect(deps.updateBlockCoordinates).toHaveBeenCalledWith(
      'block-010101',
      expect.closeTo(34.15, 6),
      expect.closeTo(74.15, 6),
    );
    expect(
      (deps.updateBlockCoordinates as jest.Mock).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      (deps.linkMergedSchools as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('batches school upserts at BATCH_SIZE', async () => {
    // One HP row so the manifest's two states are both present.
    const many: SourceRow[] = [row({ udise: '02010100001' })];
    for (let i = 0; i < BATCH_SIZE; i++) {
      many.push(
        row({
          udise: `01010${String(100000 + i).padStart(6, '0')}`,
          lat: `34.${i}`,
          lng: `74.${i}`,
        }),
      );
    }
    const { deps, upserts } = makeDeps(toCsv(many));
    await runSeed(deps, {
      schoolsUrl: 'x',
      manifest: 'm',
      statusMap: STATUS_MAP,
      pulledAt: PULLED_AT,
      dryRun: false,
    });
    const schoolBatches = upserts.filter((b) => b[0].type === 'school');
    expect(schoolBatches.map((b) => b.length)).toEqual([BATCH_SIZE, 1]);
  });

  it('fails when the hierarchy check finds an unreachable chain', async () => {
    const { deps } = makeDeps(toCsv(fixture()), {
      query: jest.fn(async (sql: string) =>
        /WITH RECURSIVE up/.test(sql)
          ? [{ n: 3 }]
          : sql.includes('block-coords')
            ? []
            : [{ n: 0 }],
      ),
    });
    await expect(
      runSeed(deps, {
        schoolsUrl: 'x',
        manifest: 'm',
        statusMap: FULL_STATUS_MAP,
        pulledAt: PULLED_AT,
        dryRun: false,
      }),
    ).rejects.toThrow(/3 chains do not reach IN/);
  });
});
