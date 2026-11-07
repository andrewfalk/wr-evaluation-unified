// 서버 테스트용 가짜 pg Pool (REFACTORING_ROADMAP P0-11).
//
// 기존 라우트 테스트 대부분은 `pool.query`에 `mockResolvedValueOnce`를 호출 순서대로 쌓는다 —
// 쿼리 하나가 추가·재배치되면 엉뚱한 응답이 엉뚱한 쿼리로 가서, 실패 원인이 보이지 않는 곳에서 깨진다.
// 이 가짜 Pool은 응답을 "순서"가 아니라 SQL(과 선택적으로 params)로 고른다:
//
//   const fake = createFakePool({
//     handlers: [
//       authSessionHandler(),
//       { name: 'presets.list', match: /FROM custom_presets cp/, reply: { rows: [row] } },
//     ],
//   });
//   const app = makeRouterApp(a => a.use('/api/presets', createPresetsRouter(fake.pool)));
//
// 규칙
// - handler는 배열 순서대로 검사하고 처음 맞는 것이 응답한다. `times`를 다 쓴 handler는 건너뛴다.
// - 어느 handler에도 맞지 않는 SQL은 **오류로 거부**한다(조용히 빈 결과를 돌려주지 않는다). 라우트가
//   그 오류를 500으로 바꿔 삼키더라도 `fake.unmatched`에 남으므로 `assertNoUnmatched()`로 원인을 본다.
// - `pool.query`와 `pool.connect()`가 주는 client의 `query`는 같은 handler 목록을 쓴다.
// - client의 BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE는 handler가 없으면 기본으로 빈 결과를 주고,
//   handler가 있든 없든 `fake.transactions`에 기록한다. `pool.query('BEGIN')`은 실제 pg에서 매번 다른
//   연결로 갈 수 있는 버그이므로 오류로 거부한다.
// - `client.release()`를 두 번 부르면 실제 pg처럼 오류. 테스트 끝에 `assertAllReleased()`로 누수 검사.
//
// vitest에 의존하지 않는다(가짜 Pool 자체가 호출 기록을 갖는다). `src/testing/**`는
// tsconfig.build.json에서 빌드 제외라 운영 dist에 들어가지 않는다.

import type { Pool, PoolClient, QueryResult } from 'pg';

export interface FakeQueryReply {
  rows?: unknown[];
  /** 생략하면 rows.length. */
  rowCount?: number | null;
}

export type FakeReplyFn = (
  sql: string,
  params: readonly unknown[],
) => FakeQueryReply | Error | Promise<FakeQueryReply | Error>;

export interface QueryHandler {
  /** 기록·오류 메시지에 쓰는 이름. */
  name: string;
  /** RegExp는 SQL 전체에 test(), 함수는 SQL을 받아 true/false. */
  match: RegExp | ((sql: string) => boolean);
  /** params까지 맞아야 할 때. */
  params?: (params: readonly unknown[]) => boolean;
  /** 응답. Error면 쿼리가 그 오류로 거부된다(pg 오류 코드는 pgError()로). */
  reply: FakeQueryReply | Error | FakeReplyFn;
  /** 이 handler가 응답할 최대 횟수. 생략하면 무제한. */
  times?: number;
}

export interface RecordedQuery {
  sql: string;
  params: readonly unknown[];
  /** 응답한 handler 이름. 기본 트랜잭션 처리는 'transaction-control', 미매치는 null. */
  handler: string | null;
  via: 'pool' | 'client';
  /** via === 'client'일 때 connect() 순번(1부터). */
  clientId?: number;
}

export interface RecordedTransaction {
  clientId: number;
  /** BEGIN부터 끝(COMMIT/ROLLBACK)까지의 트랜잭션 제어문, 대문자 첫 단어 기준. */
  statements: string[];
  outcome: 'open' | 'commit' | 'rollback';
}

export interface FakePool {
  /** 라우터·서비스에 그대로 넘기는 값. */
  pool: Pool;
  calls: RecordedQuery[];
  unmatched: RecordedQuery[];
  transactions: RecordedTransaction[];
  /** connect()로 나간 client 수. */
  readonly connected: number;
  /** release()된 client 수. */
  readonly released: number;
  /** 이름이 같은 handler가 응답한 쿼리만. */
  callsTo(handlerName: string): RecordedQuery[];
  /** 미매치 쿼리가 있으면 SQL 앞부분을 담아 throw. */
  assertNoUnmatched(): void;
  /** release되지 않은 client가 있으면 throw. */
  assertAllReleased(): void;
}

export interface CreateFakePoolOptions {
  handlers?: QueryHandler[];
}

const TX_CONTROL = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const SQL_PREVIEW_CHARS = 160;

export function sqlPreview(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > SQL_PREVIEW_CHARS ? `${flat.slice(0, SQL_PREVIEW_CHARS)}…` : flat;
}

/** pg가 던지는 오류 모양(`code` 속성). 예: `pgError('23505')`는 유니크 위반. */
export function pgError(code: string, message = `fake pg error ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function toResult(reply: FakeQueryReply): QueryResult {
  const rows = reply.rows ?? [];
  return {
    rows,
    rowCount: reply.rowCount === undefined ? rows.length : reply.rowCount,
    command: '',
    oid: 0,
    fields: [],
  } as QueryResult;
}

function readQueryArgs(textOrConfig: unknown, values: unknown): { sql: string; params: readonly unknown[] } {
  if (typeof values === 'function') {
    throw new Error('fakePool: callback-style query() is not supported — use the promise form');
  }
  if (typeof textOrConfig === 'string') {
    return { sql: textOrConfig, params: Array.isArray(values) ? values : [] };
  }
  if (textOrConfig && typeof textOrConfig === 'object' && typeof (textOrConfig as { text?: unknown }).text === 'string') {
    const cfg = textOrConfig as { text: string; values?: unknown };
    const params = Array.isArray(values) ? values : Array.isArray(cfg.values) ? cfg.values : [];
    return { sql: cfg.text, params };
  }
  throw new Error('fakePool: query() needs a SQL string or a { text, values } config');
}

function matches(handler: QueryHandler, sql: string, params: readonly unknown[]): boolean {
  const sqlOk = handler.match instanceof RegExp
    // lastIndex가 남는 g/y 플래그 정규식도 매번 처음부터 검사되도록.
    ? (handler.match.lastIndex = 0, handler.match.test(sql))
    : handler.match(sql);
  return sqlOk && (handler.params ? handler.params(params) : true);
}

export function createFakePool(options: CreateFakePoolOptions = {}): FakePool {
  const handlers = [...(options.handlers ?? [])];
  const used = new Map<QueryHandler, number>();
  const calls: RecordedQuery[] = [];
  const unmatched: RecordedQuery[] = [];
  const transactions: RecordedTransaction[] = [];
  const openTx = new Map<number, RecordedTransaction>();
  let connected = 0;
  let released = 0;
  const releasedIds = new Set<number>();

  function recordTxControl(clientId: number, sql: string): void {
    const word = sql.trim().split(/\s+/)[0]!.toUpperCase();
    if (word === 'BEGIN' || word === 'START') {
      const tx: RecordedTransaction = { clientId, statements: ['BEGIN'], outcome: 'open' };
      transactions.push(tx);
      openTx.set(clientId, tx);
      return;
    }
    const tx = openTx.get(clientId);
    if (!tx) return;
    // ROLLBACK TO SAVEPOINT는 트랜잭션을 끝내지 않는다.
    const isRollbackTo = word === 'ROLLBACK' && /^\s*ROLLBACK\s+TO\b/i.test(sql);
    tx.statements.push(isRollbackTo ? 'ROLLBACK TO' : word);
    if (word === 'COMMIT' || word === 'END') {
      tx.outcome = 'commit';
      openTx.delete(clientId);
    } else if (word === 'ROLLBACK' && !isRollbackTo) {
      tx.outcome = 'rollback';
      openTx.delete(clientId);
    }
  }

  async function run(via: 'pool' | 'client', clientId: number | undefined, textOrConfig: unknown, values: unknown): Promise<QueryResult> {
    const { sql, params } = readQueryArgs(textOrConfig, values);
    const isTxControl = TX_CONTROL.test(sql);

    if (via === 'pool' && isTxControl) {
      const call: RecordedQuery = { sql, params, handler: null, via };
      calls.push(call);
      unmatched.push(call);
      throw new Error(
        `fakePool: transaction control "${sqlPreview(sql)}" was sent through pool.query — ` +
        'real pg may run each pool.query on a different connection; use pool.connect() and the client',
      );
    }
    if (via === 'client' && clientId !== undefined && releasedIds.has(clientId)) {
      throw new Error(`fakePool: client #${clientId} was used after release(): ${sqlPreview(sql)}`);
    }
    if (via === 'client' && clientId !== undefined && isTxControl) {
      recordTxControl(clientId, sql);
    }

    const handler = handlers.find(h => {
      if (h.times !== undefined && (used.get(h) ?? 0) >= h.times) return false;
      return matches(h, sql, params);
    });

    const call: RecordedQuery = {
      sql,
      params,
      handler: handler?.name ?? (isTxControl ? 'transaction-control' : null),
      via,
      ...(clientId !== undefined ? { clientId } : {}),
    };
    calls.push(call);

    if (!handler) {
      if (isTxControl) return toResult({ rows: [], rowCount: null });
      unmatched.push(call);
      const exhausted = handlers.filter(h => h.times !== undefined && (used.get(h) ?? 0) >= h.times && matches(h, sql, params));
      const hint = exhausted.length > 0
        ? ` (matching handler(s) already used up their times: ${exhausted.map(h => h.name).join(', ')})`
        : '';
      throw new Error(`fakePool: no handler matched ${via} query: ${sqlPreview(sql)}${hint}`);
    }

    used.set(handler, (used.get(handler) ?? 0) + 1);
    const reply = typeof handler.reply === 'function' ? await handler.reply(sql, params) : handler.reply;
    if (reply instanceof Error) throw reply;
    return toResult(reply);
  }

  function makeClient(clientId: number): PoolClient {
    const client = {
      query: (textOrConfig: unknown, values?: unknown) => run('client', clientId, textOrConfig, values),
      release: () => {
        if (releasedIds.has(clientId)) {
          throw new Error(`fakePool: client #${clientId} release() called twice`);
        }
        releasedIds.add(clientId);
        released += 1;
      },
    };
    return client as unknown as PoolClient;
  }

  const pool = {
    query: (textOrConfig: unknown, values?: unknown) => run('pool', undefined, textOrConfig, values),
    connect: async () => {
      connected += 1;
      return makeClient(connected);
    },
    end: async () => undefined,
    on: () => pool,
  };

  return {
    pool: pool as unknown as Pool,
    calls,
    unmatched,
    transactions,
    get connected() { return connected; },
    get released() { return released; },
    callsTo: (handlerName: string) => calls.filter(c => c.handler === handlerName),
    assertNoUnmatched() {
      if (unmatched.length === 0) return;
      const list = unmatched.map(c => `  - [${c.via}] ${sqlPreview(c.sql)}`).join('\n');
      throw new Error(`fakePool: ${unmatched.length} unmatched quer${unmatched.length === 1 ? 'y' : 'ies'}:\n${list}`);
    },
    assertAllReleased() {
      if (released === connected) return;
      const leaked: number[] = [];
      for (let id = 1; id <= connected; id += 1) if (!releasedIds.has(id)) leaked.push(id);
      throw new Error(`fakePool: ${leaked.length} client(s) not released: #${leaked.join(', #')}`);
    },
  };
}

export interface AuthSessionHandlerOptions {
  /** 세션이 폐기·만료된 경우(인증 미들웨어가 401 SESSION_REVOKED). */
  revoked?: boolean;
  /** 사용자 비활성화 시각(인증 미들웨어가 401 USER_DISABLED). */
  disabledAt?: string | null;
}

/**
 * 인증 미들웨어(`middleware/auth.ts`)의 세션 생존 확인 쿼리에 답하는 handler.
 * 기본은 살아 있는 세션 + 활성 사용자.
 */
export function authSessionHandler(options: AuthSessionHandlerOptions = {}): QueryHandler {
  return {
    name: 'auth.session',
    match: /FROM\s+sessions\s+s\s+JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*s\.user_id/i,
    reply: options.revoked ? { rows: [] } : { rows: [{ disabled_at: options.disabledAt ?? null }] },
  };
}
