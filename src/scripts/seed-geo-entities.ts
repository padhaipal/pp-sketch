/**
 * Seeds geo_entity from the india-school-coordinates register (one CSV that
 * carries the whole hierarchy). Pure cleaning rules + a two-pass orchestrator
 * with injected I/O so the rules are unit-testable without a database. The
 * CLI wrapper is seed-geo-entities.main.ts; the runbook is
 * src/docs/seeding-geo-entities.md; the rules are documented in
 * seed-geo-entities.prompt.md.
 */
import { parse } from 'csv-parse';
import type { Readable } from 'stream';
import type {
  GeoEntityStatus,
  GeoEntityType,
  GeoEntityUpsertRow,
  ManagementGroup,
} from '../geo-entities/geo-entity.dto';
import type { MergeEdge } from '../geo-entities/geo-entity.service';
import { backfillBlockCoords } from './backfill-block-coords';

// ─── Arguments ───────────────────────────────────────────────────────────────

export const DEFAULT_SCHOOLS_URL =
  'https://github.com/DavidChristopherNelson/india-school-coordinates/releases/latest/download/schools_india_with_coords.csv.gz';

export interface SeedArgs {
  schoolsUrl: string;
  manifest: string;
  statusMap: Record<string, GeoEntityStatus>;
  pulledAt: Date;
  dryRun: boolean;
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): SeedArgs {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags.set(arg.slice(2), argv[++i]);
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  const str = (key: string): string | undefined => {
    const v = flags.get(key);
    return typeof v === 'string' ? v : undefined;
  };

  const pulledAtRaw = str('pulled-at');
  const pulledAt = pulledAtRaw ? new Date(pulledAtRaw) : null;
  if (!pulledAt || Number.isNaN(pulledAt.getTime())) {
    throw new Error('--pulled-at <ISO timestamp> is required');
  }

  const dashboard = env.DASHBOARD_PUBLIC_URL?.replace(/\/+$/, '');
  const manifest =
    str('manifest') ??
    (dashboard ? `${dashboard}/boundaries/boundaries_manifest.csv` : undefined);
  if (!manifest) {
    throw new Error(
      '--manifest <path|url> is required when DASHBOARD_PUBLIC_URL is unset',
    );
  }

  let statusMap: Record<string, GeoEntityStatus> = { ...SCHOOL_STATUS_MAP };
  const statusMapRaw = str('status-map');
  if (statusMapRaw) {
    const text = statusMapRaw.trim().startsWith('{')
      ? statusMapRaw
      : readFile(statusMapRaw);
    statusMap = { ...statusMap, ...parseStatusMap(text) };
  }

  return {
    schoolsUrl: str('schools-url') ?? DEFAULT_SCHOOLS_URL,
    manifest,
    statusMap,
    pulledAt,
    dryRun: flags.get('dry-run') === true,
  };
}

// ─── Status ──────────────────────────────────────────────────────────────────

export const GEO_STATUS_VALUES: readonly GeoEntityStatus[] = [
  'operational',
  'closed',
  'permanently_closed',
  'merged',
  'sanctioned_not_operational',
  'dcf_not_received',
];

// schoolStatusName (the KYS label) → geo_entity_status. Only Operational is
// known from the sample; the other five labels come out of the dry run
// (distinct (schoolStatus, schoolStatusName) pairs) and are pinned here in a
// follow-up commit. Override for one run with --status-map.
// TODO: fill the remaining five from the first dry run's output.
export const SCHOOL_STATUS_MAP: Record<string, GeoEntityStatus> = {
  Operational: 'operational',
};

export class UnmappedStatusError extends Error {
  constructor(readonly statusName: string) {
    super(
      `unmapped schoolStatusName ${JSON.stringify(statusName)} — add it to SCHOOL_STATUS_MAP or pass --status-map`,
    );
    this.name = 'UnmappedStatusError';
  }
}

export function parseStatusMap(text: string): Record<string, GeoEntityStatus> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--status-map must be a JSON object');
  }
  const out: Record<string, GeoEntityStatus> = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!GEO_STATUS_VALUES.includes(value as GeoEntityStatus)) {
      throw new Error(
        `--status-map: ${JSON.stringify(key)} → ${JSON.stringify(value)} is not one of ${GEO_STATUS_VALUES.join(', ')}`,
      );
    }
    out[key] = value as GeoEntityStatus;
  }
  return out;
}

export function mapSchoolStatus(
  statusName: string,
  map: Record<string, GeoEntityStatus>,
): GeoEntityStatus {
  const mapped = map[statusName.trim()];
  if (!mapped) throw new UnmappedStatusError(statusName);
  return mapped;
}

// ─── Per-row rules ───────────────────────────────────────────────────────────

export type SourceRow = Record<string, string>;

// Backstop for a stray comma that leaves the field count intact: a shifted
// row fails one of these. Returns the reason or null.
export function checkRowFormat(row: SourceRow): string | null {
  const udise = (row.udise_code ?? '').trim();
  if (!/^\d{11}$/.test(udise)) return `udise_code ${JSON.stringify(udise)}`;
  if (!/^\d{2}$/.test(row.state_code ?? '')) {
    return `state_code ${JSON.stringify(row.state_code)}`;
  }
  if (!/^\d{4}$/.test(row.district_code ?? '')) {
    return `district_code ${JSON.stringify(row.district_code)}`;
  }
  if (!/^\d{6}$/.test(row.block_code ?? '')) {
    return `block_code ${JSON.stringify(row.block_code)}`;
  }
  if (!(row.school_name ?? '').trim()) return 'blank school_name';
  return null;
}

// schBroadMgmtId → management_group. 1 and 3 are confirmed from the sample
// (Department of Education / Private Unaided); the rest map to `other` until
// the dry run's (schBroadMgmtId, schMgmtDesc) output pins them.
export function managementGroup(schBroadMgmtId: string): ManagementGroup {
  switch ((schBroadMgmtId ?? '').trim()) {
    case '1':
      return 'government';
    case '3':
      return 'private';
    default:
      return 'other';
  }
}

// classFrm / classTo, with blanks estimated from `category`.
const CATEGORY_CLASS_RANGE: Record<string, [number | null, number | null]> = {
  Primary: [1, 5],
  'Primary with Upper Primary': [1, 8],
  'Pre-Primary': [null, null],
};

export function classRange(row: SourceRow): {
  class_from: number | null;
  class_to: number | null;
  estimated: boolean;
} {
  const from = parseInt((row.classFrm ?? '').trim(), 10);
  const to = parseInt((row.classTo ?? '').trim(), 10);
  if (Number.isInteger(from) && Number.isInteger(to) && from > 0 && to > 0) {
    return { class_from: from, class_to: to, estimated: false };
  }
  const byCategory = CATEGORY_CLASS_RANGE[(row.category ?? '').trim()];
  if (byCategory) {
    return {
      class_from: byCategory[0],
      class_to: byCategory[1],
      estimated: true,
    };
  }
  return { class_from: null, class_to: null, estimated: true };
}

// Exact-coordinate grouping key for the village-centroid rule; null when the
// row has no usable coordinate (blank, non-numeric, or 0,0).
export function coordinateKey(row: SourceRow): string | null {
  const lat = Number((row.latitude ?? '').trim());
  const lng = Number((row.longitude ?? '').trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return `${row.latitude.trim()},${row.longitude.trim()}`;
}

// A coordinate shared by SUSPECT_GROUP_SIZE or more operational schools is a
// village centroid typed once (upstream: "shares a coordinate with 3+
// others"): it goes to attributes.suspect_lat/lng and lat/lng stay null.
export const SUSPECT_GROUP_SIZE = 4;

export function resolveCoordinates(
  row: SourceRow,
  groupCounts: Map<string, number>,
): { lat: number | null; lng: number | null; suspect: boolean } {
  const key = coordinateKey(row);
  if (key === null) return { lat: null, lng: null, suspect: false };
  const lat = Number(row.latitude.trim());
  const lng = Number(row.longitude.trim());
  if ((groupCounts.get(key) ?? 0) >= SUSPECT_GROUP_SIZE) {
    return { lat, lng, suspect: true };
  }
  return { lat, lng, suspect: false };
}

// The allowlisted source columns kept per school (1.73M rows × the full 67
// columns would be ~2.9 GB of jsonb). schoolId must stay: the merged-pointer
// update joins on it. The full row is always available in the release.
export const SCHOOL_ATTRIBUTE_KEYS = [
  'schoolId',
  'schIdMerged',
  'clusterCd',
  'cluster',
  'schoolStatus',
  'schoolStatusName',
  'schBroadMgmtId',
  'schCategoryId',
  'schType',
  'villageId',
  'coord_source',
] as const;

export function schoolAttributes(
  row: SourceRow,
  derived: {
    suspect_lat?: number;
    suspect_lng?: number;
    class_range_estimated?: boolean;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SCHOOL_ATTRIBUTE_KEYS) {
    const value = row[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  if (derived.suspect_lat !== undefined) out.suspect_lat = derived.suspect_lat;
  if (derived.suspect_lng !== undefined) out.suspect_lng = derived.suspect_lng;
  if (derived.class_range_estimated) out.class_range_estimated = true;
  return out;
}

// Merge pointers are set only on non-operational rows; "0"/blank means none.
export function mergeTargetSchoolId(
  row: SourceRow,
  status: GeoEntityStatus,
): string | null {
  if (status === 'operational') return null;
  const target = (row.schIdMerged ?? '').trim();
  if (target === '' || target === '0') return null;
  if (target === (row.schoolId ?? '').trim()) return null;
  return target;
}

// Cycle breaking over the merged_into_id graph. Returns the ids whose
// pointer must be nulled: in each cycle the operational member(s), or every
// member when none is operational (ambiguous).
export function findMergeCycleBreaks(edges: MergeEdge[]): string[] {
  const next = new Map(edges.map((e) => [e.id, e.merged_into_id]));
  const status = new Map(edges.map((e) => [e.id, e.status]));
  const state = new Map<string, 'visiting' | 'done'>();
  const breaks = new Set<string>();

  for (const start of next.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let node: string | undefined = start;
    while (node !== undefined && next.has(node) && !state.has(node)) {
      state.set(node, 'visiting');
      path.push(node);
      node = next.get(node);
    }
    if (node !== undefined && state.get(node) === 'visiting') {
      const cycle = path.slice(path.indexOf(node));
      const operational = cycle.filter(
        (id) => status.get(id) === 'operational',
      );
      for (const id of operational.length > 0 ? operational : cycle) {
        breaks.add(id);
      }
    }
    for (const id of path) state.set(id, 'done');
  }
  return [...breaks];
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface Manifest {
  states: Set<string>;
  districts: Set<string>;
  country: Set<string>;
}

export function parseManifest(text: string): Manifest {
  const manifest: Manifest = {
    states: new Set(),
    districts: new Set(),
    country: new Set(),
  };
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0]?.split(',') ?? [];
  const typeIdx = header.indexOf('type');
  const codeIdx = header.indexOf('code');
  if (typeIdx < 0 || codeIdx < 0) {
    throw new Error('boundaries_manifest.csv must have type and code columns');
  }
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const type = cols[typeIdx];
    const code = cols[codeIdx];
    if (type === 'state') manifest.states.add(code);
    else if (type === 'district') manifest.districts.add(code);
    else if (type === 'country') manifest.country.add(code);
  }
  return manifest;
}

// ─── Pass 1: validate + report ───────────────────────────────────────────────

class Counter<K> extends Map<K, number> {
  bump(key: K, by = 1): void {
    this.set(key, (this.get(key) ?? 0) + by);
  }
  top(): K | null {
    let best: K | null = null;
    let bestCount = -1;
    for (const [key, count] of this) {
      if (count > bestCount) {
        best = key;
        bestCount = count;
      }
    }
    return best;
  }
}

interface LevelNode {
  names: Counter<string>;
  parentCode: string | null;
  parentCodes: Counter<string>;
  lgdIds: Counter<string>;
}

export interface Pass1Report {
  rows: number;
  skippedParse: number;
  skippedFormat: number;
  skippedPseudoState: number;
  duplicateSchoolCodes: number;
  schools: number;
  states: number;
  districts: number;
  blocks: number;
  statusPairs: Map<string, number>;
  managementPairs: Map<string, number>;
  clusterCdLengths: Map<number, number>;
  clustersSpanningBlocks: number;
  meanAttributesBytes: number;
  unmappedStatuses: Map<string, number>;
  errors: string[];
}

export class Pass1Accumulator {
  readonly states = new Map<string, LevelNode>();
  readonly districts = new Map<string, LevelNode>();
  readonly blocks = new Map<string, LevelNode>();
  readonly schoolCodes = new Set<string>();
  readonly coordCounts = new Counter<string>();
  private readonly statusPairs = new Counter<string>();
  private readonly managementPairs = new Counter<string>();
  private readonly clusterCdLengths = new Counter<number>();
  private readonly clusterBlocks = new Map<string, Set<string>>();
  private readonly unmappedStatuses = new Counter<string>();
  private readonly formatFailures: string[] = [];
  private rows = 0;
  private skippedParse = 0;
  private skippedFormat = 0;
  private skippedPseudoState = 0;
  private duplicateSchoolCodes = 0;
  private attributesBytes = 0;
  private schools = 0;

  constructor(
    private readonly manifest: Manifest,
    private readonly statusMap: Record<string, GeoEntityStatus>,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  recordParseSkip(): void {
    this.skippedParse += 1;
  }

  add(row: SourceRow): void {
    this.rows += 1;
    if (this.rows % 100_000 === 0) {
      this.log(`pass 1: ${this.rows.toLocaleString()} rows`);
    }
    const formatError = checkRowFormat(row);
    if (formatError) {
      this.skippedFormat += 1;
      if (this.formatFailures.length < 20) {
        this.formatFailures.push(
          `row ${this.rows}: ${formatError} (udise ${JSON.stringify(row.udise_code)})`,
        );
      }
      return;
    }
    // Central bodies (KVS/NVS/Navy/IAF) are pseudo-states with no boundary:
    // the manifest's 36 state files define the real set.
    if (!this.manifest.states.has(row.state_code)) {
      this.skippedPseudoState += 1;
      return;
    }
    this.statusPairs.bump(
      `${(row.schoolStatus ?? '').trim()}|${(row.schoolStatusName ?? '').trim()}`,
    );
    this.managementPairs.bump(
      `${(row.schBroadMgmtId ?? '').trim()}|${(row.schMgmtDesc ?? '').trim()}`,
    );
    const clusterCd = (row.clusterCd ?? '').trim();
    this.clusterCdLengths.bump(clusterCd.length);
    if (clusterCd) {
      const blocks = this.clusterBlocks.get(clusterCd) ?? new Set<string>();
      blocks.add(row.block_code);
      this.clusterBlocks.set(clusterCd, blocks);
    }

    const udise = row.udise_code.trim();
    if (this.schoolCodes.has(udise)) {
      this.duplicateSchoolCodes += 1;
      return;
    }
    this.schoolCodes.add(udise);
    this.schools += 1;

    let status: GeoEntityStatus | null = null;
    try {
      status = mapSchoolStatus(row.schoolStatusName ?? '', this.statusMap);
    } catch (err) {
      if (err instanceof UnmappedStatusError) {
        this.unmappedStatuses.bump(err.statusName);
      } else {
        throw err;
      }
    }
    if (status === 'operational') {
      const key = coordinateKey(row);
      if (key) this.coordCounts.bump(key);
    }
    this.attributesBytes += JSON.stringify(
      schoolAttributes(
        row,
        classRange(row).estimated ? { class_range_estimated: true } : {},
      ),
    ).length;

    this.touch(this.states, row.state_code, row.state, null, row.lgdStateId);
    this.touch(
      this.districts,
      row.district_code,
      row.district,
      row.state_code,
      undefined,
    );
    this.touch(
      this.blocks,
      row.block_code,
      row.block,
      row.district_code,
      row.lgdblockId,
    );
  }

  private touch(
    level: Map<string, LevelNode>,
    code: string,
    name: string,
    parentCode: string | null,
    lgdId: string | undefined,
  ): void {
    let node = level.get(code);
    if (!node) {
      node = {
        names: new Counter(),
        parentCode,
        parentCodes: new Counter(),
        lgdIds: new Counter(),
      };
      level.set(code, node);
    }
    node.names.bump((name ?? '').trim());
    if (parentCode !== null) node.parentCodes.bump(parentCode);
    const lgd = (lgdId ?? '').trim();
    if (lgd && lgd !== '0') node.lgdIds.bump(lgd);
  }

  // Majority name / parent / lgd id for a derived level.
  resolved(
    level: Map<string, LevelNode>,
  ): Map<
    string,
    { name: string; parentCode: string | null; lgdCode: string | null }
  > {
    const out = new Map<
      string,
      { name: string; parentCode: string | null; lgdCode: string | null }
    >();
    for (const [code, node] of level) {
      out.set(code, {
        name: node.names.top() ?? code,
        parentCode: node.parentCodes.size > 0 ? node.parentCodes.top() : null,
        lgdCode: node.lgdIds.size === 1 ? node.lgdIds.top() : null,
      });
    }
    return out;
  }

  finish(): Pass1Report {
    const errors: string[] = [];
    for (const [code, node] of this.districts) {
      if (node.parentCodes.size > 1) {
        errors.push(
          `district ${code} appears under ${node.parentCodes.size} states: ${[...node.parentCodes.keys()].join(', ')}`,
        );
      }
      const parent = node.parentCodes.top();
      if (parent === null || !this.states.has(parent)) {
        errors.push(`district ${code} has no state ${String(parent)}`);
      }
    }
    for (const [code, node] of this.blocks) {
      if (node.parentCodes.size > 1) {
        errors.push(
          `block ${code} appears under ${node.parentCodes.size} districts: ${[...node.parentCodes.keys()].join(', ')}`,
        );
      }
      const parent = node.parentCodes.top();
      if (parent === null || !this.districts.has(parent)) {
        errors.push(`block ${code} has no district ${String(parent)}`);
      }
    }
    if (this.unmappedStatuses.size > 0) {
      errors.push(
        `unmapped schoolStatusName values: ${[...this.unmappedStatuses]
          .map(([name, count]) => `${JSON.stringify(name)} ×${count}`)
          .join(', ')} — fill SCHOOL_STATUS_MAP or pass --status-map`,
      );
    }
    if (this.states.size !== this.manifest.states.size) {
      errors.push(
        `expected ${this.manifest.states.size} states from the manifest, saw ${this.states.size}`,
      );
    }
    if (this.schools === 0) errors.push('no valid school rows');
    errors.push(...this.formatFailures.map((f) => `format: ${f}`));

    let clustersSpanningBlocks = 0;
    for (const blocks of this.clusterBlocks.values()) {
      if (blocks.size > 1) clustersSpanningBlocks += 1;
    }

    return {
      rows: this.rows,
      skippedParse: this.skippedParse,
      skippedFormat: this.skippedFormat,
      skippedPseudoState: this.skippedPseudoState,
      duplicateSchoolCodes: this.duplicateSchoolCodes,
      schools: this.schools,
      states: this.states.size,
      districts: this.districts.size,
      blocks: this.blocks.size,
      statusPairs: this.statusPairs,
      managementPairs: this.managementPairs,
      clusterCdLengths: this.clusterCdLengths,
      clustersSpanningBlocks,
      meanAttributesBytes:
        this.schools > 0 ? Math.round(this.attributesBytes / this.schools) : 0,
      unmappedStatuses: this.unmappedStatuses,
      errors: errors.filter((e) => !e.startsWith('format: ')),
    };
  }
}

export function formatReport(report: Pass1Report): string {
  const lines: string[] = [];
  lines.push(`rows read: ${report.rows.toLocaleString()}`);
  lines.push(
    `skipped — parse errors: ${report.skippedParse.toLocaleString()}, format checks: ${report.skippedFormat.toLocaleString()}, pseudo-states: ${report.skippedPseudoState.toLocaleString()}, duplicate udise codes: ${report.duplicateSchoolCodes.toLocaleString()}`,
  );
  lines.push(
    `levels — states: ${report.states}, districts: ${report.districts}, blocks: ${report.blocks.toLocaleString()}, schools: ${report.schools.toLocaleString()}`,
  );
  lines.push('distinct (schoolStatus, schoolStatusName):');
  for (const [pair, count] of report.statusPairs) {
    lines.push(`  ${pair}  ×${count.toLocaleString()}`);
  }
  lines.push('distinct (schBroadMgmtId, schMgmtDesc):');
  for (const [pair, count] of [...report.managementPairs].sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`  ${pair}  ×${count.toLocaleString()}`);
  }
  lines.push('clusterCd length distribution:');
  for (const [len, count] of [...report.clusterCdLengths].sort(
    (a, b) => a[0] - b[0],
  )) {
    lines.push(`  ${len}: ${count.toLocaleString()}`);
  }
  lines.push(
    `clusters spanning more than one block: ${report.clustersSpanningBlocks.toLocaleString()}`,
  );
  lines.push(
    `mean attributes size per school: ${report.meanAttributesBytes} bytes`,
  );
  if (report.errors.length > 0) {
    lines.push(`VALIDATION FAILED (${report.errors.length}):`);
    for (const error of report.errors.slice(0, 50)) lines.push(`  ${error}`);
  } else {
    lines.push('validation passed');
  }
  return lines.join('\n');
}

// ─── CSV streaming ───────────────────────────────────────────────────────────

// Streams a decompressed CSV as header-keyed rows. A record with the wrong
// field count (a stray unescaped comma) is skipped via csv-parse's
// skip_records_with_error — never a stream error — and reported to onSkip.
export function streamCsvRows(
  input: Readable,
  onSkip: (error: Error) => void,
): AsyncIterable<SourceRow> {
  const parser = parse({
    columns: true,
    bom: true,
    skip_records_with_error: true,
    skip_empty_lines: true,
    relax_quotes: true,
  });
  parser.on('skip', (err: Error) => onSkip(err));
  return input.pipe(parser) as unknown as AsyncIterable<SourceRow>;
}

// ─── Pass 2: build rows ──────────────────────────────────────────────────────

export const COUNTRY_CODE = 'IN';
export const COUNTRY_NAME = 'India';
export const NON_SCHOOL_SOURCE = 'kys_by_region';
export const SCHOOL_SOURCE = 'kys_by_year';

export function buildLevelRows(
  type: Exclude<GeoEntityType, 'school' | 'cluster'>,
  resolved: Map<
    string,
    { name: string; parentCode: string | null; lgdCode: string | null }
  >,
  parentIds: Map<string, string> | null,
  manifest: Manifest,
  pulledAt: Date,
): { rows: GeoEntityUpsertRow[]; missingParents: string[] } {
  const rows: GeoEntityUpsertRow[] = [];
  const missingParents: string[] = [];
  const boundarySet =
    type === 'state'
      ? manifest.states
      : type === 'district'
        ? manifest.districts
        : type === 'country'
          ? manifest.country
          : new Set<string>();
  for (const [code, node] of resolved) {
    let parent_id: string | null = null;
    if (parentIds) {
      parent_id = node.parentCode
        ? (parentIds.get(node.parentCode) ?? null)
        : null;
      if (!parent_id) {
        missingParents.push(`${type} ${code} → ${String(node.parentCode)}`);
        continue;
      }
    }
    rows.push({
      type,
      parent_id,
      code,
      name: node.name,
      lgd_code: node.lgdCode,
      lat: null,
      lng: null,
      has_boundary: boundarySet.has(code),
      status: 'operational',
      management_group: null,
      class_from: null,
      class_to: null,
      attributes: {},
      source: NON_SCHOOL_SOURCE,
      source_pulled_at: pulledAt,
    });
  }
  return { rows, missingParents };
}

export function buildSchoolRow(
  row: SourceRow,
  blockIds: Map<string, string>,
  coordCounts: Map<string, number>,
  statusMap: Record<string, GeoEntityStatus>,
  pulledAt: Date,
): GeoEntityUpsertRow | null {
  const parent_id = blockIds.get(row.block_code);
  if (!parent_id) return null;
  const status = mapSchoolStatus(row.schoolStatusName ?? '', statusMap);
  const range = classRange(row);
  const coords = resolveCoordinates(row, coordCounts);
  const attributes = schoolAttributes(row, {
    ...(coords.suspect && coords.lat !== null && coords.lng !== null
      ? { suspect_lat: coords.lat, suspect_lng: coords.lng }
      : {}),
    class_range_estimated: range.estimated,
  });
  return {
    type: 'school',
    parent_id,
    code: row.udise_code.trim(),
    name: row.school_name.trim(),
    lgd_code: null,
    lat: coords.suspect ? null : coords.lat,
    lng: coords.suspect ? null : coords.lng,
    has_boundary: false,
    status,
    management_group: managementGroup(row.schBroadMgmtId),
    class_from: range.class_from,
    class_to: range.class_to,
    attributes,
    source: SCHOOL_SOURCE,
    source_pulled_at: pulledAt,
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export const BATCH_SIZE = 5000;

export interface SeedDeps {
  log: (message: string) => void;
  // Opens the spooled register as a decompressed row stream; called twice.
  openRows: () => Readable;
  readManifest: () => Promise<string>;
  upsertBatch: (rows: GeoEntityUpsertRow[]) => Promise<void>;
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  codeMap: (type: GeoEntityType) => Promise<Map<string, string>>;
  linkMergedSchools: () => Promise<number>;
  mergeEdges: () => Promise<MergeEdge[]>;
  clearMergedInto: (ids: string[]) => Promise<void>;
  updateBlockCoordinates: (
    id: string,
    lat: number,
    lng: number,
  ) => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
}

export async function runPass1(
  deps: Pick<SeedDeps, 'log' | 'openRows'>,
  manifest: Manifest,
  statusMap: Record<string, GeoEntityStatus>,
): Promise<{ accumulator: Pass1Accumulator; report: Pass1Report }> {
  const accumulator = new Pass1Accumulator(manifest, statusMap, deps.log);
  for await (const row of streamCsvRows(deps.openRows(), () =>
    accumulator.recordParseSkip(),
  )) {
    accumulator.add(row);
  }
  const report = accumulator.finish();
  return { accumulator, report };
}

export async function runSeed(deps: SeedDeps, args: SeedArgs): Promise<void> {
  const manifest = parseManifest(await deps.readManifest());
  deps.log(
    `manifest: ${manifest.states.size} states, ${manifest.districts.size} districts`,
  );

  const { accumulator, report } = await runPass1(
    deps,
    manifest,
    args.statusMap,
  );
  deps.log(formatReport(report));
  if (report.errors.length > 0) {
    throw new Error(`validation failed with ${report.errors.length} error(s)`);
  }
  if (args.dryRun) {
    deps.log('dry run — stopping before any write');
    return;
  }

  // country → states → districts → blocks, each level in its own transaction.
  const country = buildLevelRows(
    'country',
    new Map([
      [COUNTRY_CODE, { name: COUNTRY_NAME, parentCode: null, lgdCode: null }],
    ]),
    null,
    manifest,
    args.pulledAt,
  );
  await deps.transaction(() => deps.upsertBatch(country.rows));
  const countryIds = await deps.codeMap('country');

  const levels: Array<{
    type: 'state' | 'district' | 'block';
    resolved: ReturnType<Pass1Accumulator['resolved']>;
    parentIds: Map<string, string>;
  }> = [];
  levels.push({
    type: 'state',
    resolved: new Map(
      [...accumulator.resolved(accumulator.states)].map(([code, node]) => [
        code,
        { ...node, parentCode: COUNTRY_CODE },
      ]),
    ),
    parentIds: countryIds,
  });
  let parentIds = countryIds;
  for (const type of ['state', 'district', 'block'] as const) {
    const level =
      type === 'state'
        ? levels[0]
        : {
            type,
            resolved: accumulator.resolved(
              type === 'district' ? accumulator.districts : accumulator.blocks,
            ),
            parentIds,
          };
    const built = buildLevelRows(
      type,
      level.resolved,
      level.parentIds,
      manifest,
      args.pulledAt,
    );
    for (const missing of built.missingParents) {
      deps.log(`skip: ${missing} (parent not seeded)`);
    }
    await deps.transaction(async () => {
      for (let i = 0; i < built.rows.length; i += BATCH_SIZE) {
        await deps.upsertBatch(built.rows.slice(i, i + BATCH_SIZE));
      }
    });
    parentIds = await deps.codeMap(type);
    deps.log(`${type}: ${built.rows.length.toLocaleString()} rows upserted`);
  }

  // Schools: second stream, batched, one transaction.
  const blockIds = parentIds;
  const counts = {
    upserted: 0,
    skippedNoBlock: 0,
    skipped: 0,
    byStatus: new Counter<string>(),
  };
  await deps.transaction(async () => {
    let batch: GeoEntityUpsertRow[] = [];
    let seen = 0;
    const seenCodes = new Set<string>();
    for await (const row of streamCsvRows(deps.openRows(), () => {
      counts.skipped += 1;
    })) {
      seen += 1;
      if (seen % 100_000 === 0)
        deps.log(`pass 2: ${seen.toLocaleString()} rows`);
      if (checkRowFormat(row) || !manifest.states.has(row.state_code)) {
        counts.skipped += 1;
        continue;
      }
      const code = row.udise_code.trim();
      if (seenCodes.has(code)) {
        counts.skipped += 1;
        continue;
      }
      seenCodes.add(code);
      const built = buildSchoolRow(
        row,
        blockIds,
        accumulator.coordCounts,
        args.statusMap,
        args.pulledAt,
      );
      if (!built) {
        counts.skippedNoBlock += 1;
        deps.log(`skip: school ${code} — block ${row.block_code} not seeded`);
        continue;
      }
      counts.byStatus.bump(built.status);
      batch.push(built);
      if (batch.length >= BATCH_SIZE) {
        await deps.upsertBatch(batch);
        counts.upserted += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await deps.upsertBatch(batch);
      counts.upserted += batch.length;
    }
  });
  deps.log(
    `school: ${counts.upserted.toLocaleString()} rows upserted, ${counts.skippedNoBlock.toLocaleString()} skipped (no block), ${counts.skipped.toLocaleString()} skipped (parse/format/pseudo-state/duplicate)`,
  );

  // Merge pointers, then cycles.
  const linked = await deps.linkMergedSchools();
  deps.log(`merged_into_id: ${linked.toLocaleString()} pointers set`);
  const breaks = findMergeCycleBreaks(await deps.mergeEdges());
  if (breaks.length > 0) {
    await deps.clearMergedInto(breaks);
    deps.log(
      `merged_into_id: ${breaks.length} pointers nulled to break cycles`,
    );
  }

  // Block label points: geometric median of each block's located schools
  // (a register refresh that adds blocks locates them in the same run).
  await backfillBlockCoords({
    log: deps.log,
    query: deps.query,
    transaction: deps.transaction,
    updateBlockCoordinates: deps.updateBlockCoordinates,
  });

  // Every school reaches IN within 5 steps.
  const unreachable = (await deps.query(
    `WITH RECURSIVE up AS (
       SELECT id AS school_id, parent_id, 1 AS depth FROM geo_entity WHERE type = 'school'
       UNION ALL
       SELECT up.school_id, g.parent_id, up.depth + 1
       FROM up JOIN geo_entity g ON g.id = up.parent_id
       WHERE up.depth < 5 AND g.type <> 'country'
     )
     SELECT count(*)::int AS n FROM up
     WHERE depth = 5 OR parent_id IS NULL`,
  )) as Array<{ n: number }>;
  const orphanRows = (await deps.query(
    `SELECT count(*)::int AS n FROM geo_entity WHERE type = 'school' AND parent_id IS NULL`,
  )) as Array<{ n: number }>;
  if ((unreachable[0]?.n ?? 0) > 0 || (orphanRows[0]?.n ?? 0) > 0) {
    throw new Error(
      `hierarchy check failed: ${unreachable[0]?.n ?? 0} chains do not reach IN within 5 steps, ${orphanRows[0]?.n ?? 0} schools without a parent`,
    );
  }

  const perType = (await deps.query(
    `SELECT type, status, count(*)::int AS n FROM geo_entity GROUP BY type, status ORDER BY type, status`,
  )) as Array<{ type: string; status: string; n: number }>;
  deps.log('final counts:');
  for (const row of perType) {
    deps.log(`  ${row.type} / ${row.status}: ${row.n.toLocaleString()}`);
  }
}
