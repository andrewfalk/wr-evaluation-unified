// PR0-C §D — differencing 방어. 단일 Node 프로세스 in-memory 가정(§7.6 인트라넷 단일
// 서버 배포와 일관, 기존 rate-limit류와 동일 전제) — 서버 재시작 시 초기화되고 수평
// 확장 시 재검토가 필요하다는 한계를 그대로 갖는다.
//
// 보장 범위 고지(코드에도 명시): 완전한 차분 프라이버시 보장이 아니다. 반복 조회 비용을
// 높여 억제할 뿐이며, 허용 횟수 이내의 소수 조합으로도 이론적으로 차이가 드러날 수 있다.
import type { StatsAnalysisRecipe } from '@wr/contracts';
import { canonicalDigest } from './canonicalSerializer';
import { DIFFERENCING_POLICY, GLOBAL_QUERY_BUDGET } from './statsPolicy';

// §D — queryFamilyDigest: 필터 "값"은 절대 포함하지 않는다(값이 다른 질의를 같은 family로
// 묶는 게 목적). variableKeys/filterKeys/연산자는 여기서만 정렬해서 해시한다(recipeDigest는
// 반대로 순서를 보존 — 역할이 다르다: 이건 "동등한 모양의 질의 계열"의 지문).
export function computeQueryFamilyDigest(recipe: StatsAnalysisRecipe): string {
  const operatorsByKey = new Map<string, Set<string>>();
  for (const filter of recipe.filters) {
    let set = operatorsByKey.get(filter.key);
    if (!set) {
      set = new Set();
      operatorsByKey.set(filter.key, set);
    }
    set.add(filter.operator);
  }
  const filterOperatorsByKey = Object.fromEntries(
    Array.from(operatorsByKey.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, ops]) => [key, Array.from(ops).sort()]),
  );

  return canonicalDigest({
    grain: recipe.grain,
    variableKeys: [...recipe.variableKeys].sort(),
    filterKeys: Array.from(operatorsByKey.keys()).sort(),
    filterOperatorsByKey,
  });
}

// §D-1 — is_missing/not_missing처럼 value가 undefined인 필터는 §A 검증을 통과한 정상
// 요청이다. canonicalSerialize는 undefined를 의도적으로 throw하므로(§G, 상류 버그 신호로
// 취급) 그대로 넘기면 정상 요청이 500이 된다 — guard 전용 로컬 규칙으로 별도 취급한다.
// serializer의 undefined 거부 원칙 자체는 바꾸지 않는다.
function filterValueDigest(value: unknown): string {
  return value === undefined ? 'NO_VALUE' : canonicalDigest(value);
}

interface FamilyState {
  lastAccess: number;
  timestamps: number[];
  // digest → 마지막으로 관측된 시각. Set이 아니라 Map인 이유: family 자체가 15분보다 오래
  // 살아있을 수 있으므로(마지막 접근마다 lastAccess가 갱신됨), 가치를 셀 때마다 "그 값이
  // 최근 windowMs 안에 실제로 관측됐는지"를 개별적으로 다시 판정해야 한다 — family 단위
  // pruneFullyExpired만으로는 오래된 값이 계속 누적돼 15분이 지나도 다양성 제한이 풀리지
  // 않는 버그가 생긴다(실측 재현: 처음 서로 다른 값 11개를 조회한 뒤 이후 같은 값 0만
  // 반복 조회해도 계속 억제됨, remaining도 회복되지 않음).
  valueTimestampsByKey: Map<string, Map<string, number>>;
}

interface UserBudgetState {
  lastAccess: number;
  timestamps: number[];
}

const MAX_TRACKED_ENTRIES = 50_000; // 조직 규모(수백 사례, 소수 동시 사용자)상 도달 불가 수준.

const familyStates = new Map<string, FamilyState>();
const userBudgetStates = new Map<string, UserBudgetState>();

function pruneFullyExpired<T extends { lastAccess: number }>(map: Map<string, T>, windowMs: number, now: number): void {
  for (const [key, state] of map) {
    if (now - state.lastAccess >= windowMs) map.delete(key);
  }
}

function evictOldest<T extends { lastAccess: number }>(map: Map<string, T>): void {
  let oldestKey: string | undefined;
  let oldestAccess = Infinity;
  for (const [key, state] of map) {
    if (state.lastAccess < oldestAccess) {
      oldestAccess = state.lastAccess;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) map.delete(oldestKey);
}

export interface DifferencingCheckResult {
  forceSuppress: boolean;
  remaining: number;
}

// 완전히 동기 함수(await 없음, in-memory Map만) — Node 단일 이벤트 루프에서 동기 코드는
// 인터리빙되지 않으므로 검사-기록 사이 경쟁 조건이 구조적으로 없다.
export function checkAndRecordDifferencing(
  organizationId: string,
  userId: string,
  recipe: StatsAnalysisRecipe,
  queryFamilyDigest: string,
): DifferencingCheckResult {
  const now = Date.now();
  const familyWindowMs = DIFFERENCING_POLICY.windowMinutes * 60_000;
  const globalWindowMs = GLOBAL_QUERY_BUDGET.windowMinutes * 60_000;

  // --- family 내부 값-다양성 + 요청 수 ---
  pruneFullyExpired(familyStates, familyWindowMs, now);
  const familyKey = `${organizationId}:${userId}:${queryFamilyDigest}`;
  let family = familyStates.get(familyKey);
  if (!family) {
    if (familyStates.size >= MAX_TRACKED_ENTRIES) evictOldest(familyStates);
    family = { lastAccess: now, timestamps: [], valueTimestampsByKey: new Map() };
    familyStates.set(familyKey, family);
  }
  family.lastAccess = now;
  family.timestamps = family.timestamps.filter((t) => now - t < familyWindowMs);
  family.timestamps.push(now);

  let valueDiversityExceeded = false;
  for (const filter of recipe.filters) {
    const digest = filterValueDigest(filter.value);
    let seen = family.valueTimestampsByKey.get(filter.key);
    if (!seen) {
      seen = new Map();
      family.valueTimestampsByKey.set(filter.key, seen);
    }
    // 이 키의 값들 중 최근 windowMs 밖으로 나간 것부터 지운다 — "최근 15분의 고유값만
    // 집계"를 매 접근마다 다시 계산해야 오래된 값이 다양성 카운트에 영구히 남지 않는다.
    for (const [seenDigest, seenAt] of seen) {
      if (now - seenAt >= familyWindowMs) seen.delete(seenDigest);
    }
    seen.set(digest, now);
    if (seen.size > DIFFERENCING_POLICY.maxDistinctFilterValuesPerKey) {
      valueDiversityExceeded = true;
    }
  }

  const familyExceeded =
    family.timestamps.length > DIFFERENCING_POLICY.maxQueriesPerFamily || valueDiversityExceeded;

  // --- 전역 예산(family 우회 방어) ---
  pruneFullyExpired(userBudgetStates, globalWindowMs, now);
  const userKey = `${organizationId}:${userId}`;
  let userBudget = userBudgetStates.get(userKey);
  if (!userBudget) {
    if (userBudgetStates.size >= MAX_TRACKED_ENTRIES) evictOldest(userBudgetStates);
    userBudget = { lastAccess: now, timestamps: [] };
    userBudgetStates.set(userKey, userBudget);
  }
  userBudget.lastAccess = now;
  userBudget.timestamps = userBudget.timestamps.filter((t) => now - t < globalWindowMs);
  userBudget.timestamps.push(now);

  const globalExceeded = userBudget.timestamps.length > GLOBAL_QUERY_BUDGET.maxQueriesPerUser;

  const remaining = Math.max(0, DIFFERENCING_POLICY.maxQueriesPerFamily - family.timestamps.length);

  return { forceSuppress: familyExceeded || globalExceeded, remaining };
}

/** 테스트 전용 — 상태를 초기화해 각 테스트가 격리된 guard를 갖게 한다. */
export function __resetDifferencingGuardForTests(): void {
  familyStates.clear();
  userBudgetStates.clear();
}
