// Stats engine input limits — checked before spawning, per request kind.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
import config from '../../config';
import { MAX_STRING_LENGTH, MAX_TOTAL_VALUES, MAX_VALUES_PER_VARIABLE } from './engineLimits';
import { ENGINE_PROTOCOL_VERSION, StatsEngineRequest, BivariateEngineRequest, CorrelationMatrixEngineRequest, RegressionEngineRequest, RegressionDiagnosticsEngineRequest, PredictionEngineRequest } from './protocol';
import { StatsEngineInputTooLargeError } from './errors';

export function assertWithinLimits(request: StatsEngineRequest): void {
  let total = 0;
  for (const v of request.variables) {
    if (v.values.length > MAX_VALUES_PER_VARIABLE) {
      throw new StatsEngineInputTooLargeError(
        `variable '${v.key}' has ${v.values.length} values, exceeds MAX_VALUES_PER_VARIABLE(${MAX_VALUES_PER_VARIABLE})`,
      );
    }
    for (const value of v.values) {
      if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
        throw new StatsEngineInputTooLargeError(
          `variable '${v.key}' has a string value exceeding MAX_STRING_LENGTH(${MAX_STRING_LENGTH})`,
        );
      }
    }
    total += v.values.length;
  }
  if (total > MAX_TOTAL_VALUES) {
    throw new StatsEngineInputTooLargeError(`total values (${total}) exceeds MAX_TOTAL_VALUES(${MAX_TOTAL_VALUES})`);
  }
  const byteLength = Buffer.byteLength(JSON.stringify({ protocolVersion: ENGINE_PROTOCOL_VERSION, variables: request.variables }), 'utf8');
  if (byteLength > config.stats.maxInputBytes) {
    throw new StatsEngineInputTooLargeError(`serialized input (${byteLength} bytes) exceeds maxInputBytes(${config.stats.maxInputBytes})`);
  }
}


// PR3-A — 계획서 §"새 프로토콜의 입력상한·의미검증" 표를 그대로 구현. groups는
// "그룹 전체 합"(그룹당이 아님 — 이변량은 그룹들 합쳐서 변수 하나 취급),
// table은 "sum(모든 셀)"에 같은 상한을 적용(작은 JSON으로 큰 관측수를 표현할 수
// 있어 상한 자체가 필요, 정합성 검사와는 별개).
export function assertBivariateWithinLimits(request: BivariateEngineRequest): void {
  const byteLength = Buffer.byteLength(JSON.stringify({ protocolVersion: ENGINE_PROTOCOL_VERSION, bivariate: request }), 'utf8');
  if (byteLength > config.stats.maxInputBytes) {
    throw new StatsEngineInputTooLargeError(`serialized input (${byteLength} bytes) exceeds maxInputBytes(${config.stats.maxInputBytes})`);
  }

  if ('groups' in request) {
    const total = request.groups.reduce((sum, g) => sum + g.values.length, 0);
    if (total > MAX_VALUES_PER_VARIABLE) {
      throw new StatsEngineInputTooLargeError(
        `groups 전체 값 개수 합(${total})이 상한(${MAX_VALUES_PER_VARIABLE})을 초과`,
      );
    }
    return;
  }
  if ('table' in request) {
    const cellSum = request.table.reduce((sum, row) => sum + row.reduce((s, c) => s + c, 0), 0);
    if (cellSum > MAX_VALUES_PER_VARIABLE) {
      throw new StatsEngineInputTooLargeError(
        `table 셀 합계(${cellSum})가 상한(${MAX_VALUES_PER_VARIABLE})을 초과`,
      );
    }
    return;
  }
  // x/y(상관) — 길이가 이미 같다는 전제는 호출자(buildBivariateEngineRequest)가 보장.
  if (request.x.length > MAX_VALUES_PER_VARIABLE) {
    throw new StatsEngineInputTooLargeError(
      `x/y 값 개수(${request.x.length})가 상한(${MAX_VALUES_PER_VARIABLE})을 초과`,
    );
  }
}


// PR3-B — 상관행렬 입력상한(계획서 §8). 값 개수 상한은 기존 "variables" shape과
// 동일한 MAX_TOTAL_VALUES를 재사용한다(상관행렬 전용 새 상수를 두지 않는다).
// 바이트 길이 상한(config.stats.maxInputBytes)은 그것과 완전히 별개로 항상
// 이중 검사한다 — 20변수×17,500행처럼 값 개수 상한은 통과해도 직렬화 바이트가
// 기본 2MiB를 넘는 조합이 실제로 있다(리뷰로 확인). 검사 순서는 기존
// assertWithinLimits와 동일하게 값 개수 → 바이트 길이.
export function assertCorrelationMatrixWithinLimits(request: CorrelationMatrixEngineRequest): void {
  let total = 0;
  for (const v of request.variables) {
    if (v.values.length > MAX_VALUES_PER_VARIABLE) {
      throw new StatsEngineInputTooLargeError(
        `variable '${v.key}' has ${v.values.length} values, exceeds MAX_VALUES_PER_VARIABLE(${MAX_VALUES_PER_VARIABLE})`,
      );
    }
    total += v.values.length;
  }
  if (total > MAX_TOTAL_VALUES) {
    throw new StatsEngineInputTooLargeError(`total values (${total}) exceeds MAX_TOTAL_VALUES(${MAX_TOTAL_VALUES})`);
  }
  const byteLength = Buffer.byteLength(JSON.stringify({ protocolVersion: ENGINE_PROTOCOL_VERSION, correlationMatrix: request }), 'utf8');
  if (byteLength > config.stats.maxInputBytes) {
    throw new StatsEngineInputTooLargeError(`serialized input (${byteLength} bytes) exceeds maxInputBytes(${config.stats.maxInputBytes})`);
  }
}


// §8 — 값 개수(N×P)는 상관행렬과 동일한 MAX_TOTAL_VALUES를 재사용한다. 바이트
// 길이는 실제 전송될 envelope({protocolVersion, regression})과 바이트 단위로
// 동일한 문자열로 측정한다(§8 "몇 바이트라 무시 가능하다는 판단은 안 된다"
// 교훈 — stats/dataset/correlationMatrix.ts 3차 수정과 동일 원칙).
export function assertRegressionWithinLimits(request: RegressionEngineRequest): void {
  const n = request.y.length;
  const p = request.columnNames.length;
  if (n > MAX_VALUES_PER_VARIABLE) {
    throw new StatsEngineInputTooLargeError(`regression 행 수(${n})가 상한(${MAX_VALUES_PER_VARIABLE})을 초과`);
  }
  const total = n * p;
  if (total > MAX_TOTAL_VALUES) {
    throw new StatsEngineInputTooLargeError(`regression 전체 값 개수(N×P=${total})가 상한(${MAX_TOTAL_VALUES})을 초과`);
  }
  const byteLength = Buffer.byteLength(JSON.stringify({ protocolVersion: ENGINE_PROTOCOL_VERSION, regression: request }), 'utf8');
  if (byteLength > config.stats.maxInputBytes) {
    throw new StatsEngineInputTooLargeError(`serialized input (${byteLength} bytes) exceeds maxInputBytes(${config.stats.maxInputBytes})`);
  }
}


// PR4-A2 — limited_row 진단 요청 상한(§4 "입력 검증" — 재적합이 아니므로 최초
// 적합과 같은 N×P 상한을 그대로 재사용한다).
export function assertRegressionDiagnosticsWithinLimits(request: RegressionDiagnosticsEngineRequest): void {
  const n = request.y.length;
  const p = request.columnNames.length;
  if (n > MAX_VALUES_PER_VARIABLE) {
    throw new StatsEngineInputTooLargeError(`regressionDiagnostics 행 수(${n})가 상한(${MAX_VALUES_PER_VARIABLE})을 초과`);
  }
  const total = n * p;
  if (total > MAX_TOTAL_VALUES) {
    throw new StatsEngineInputTooLargeError(`regressionDiagnostics 전체 값 개수(N×P=${total})가 상한(${MAX_TOTAL_VALUES})을 초과`);
  }
  const byteLength = Buffer.byteLength(JSON.stringify({ protocolVersion: ENGINE_PROTOCOL_VERSION, regressionDiagnostics: request }), 'utf8');
  if (byteLength > config.stats.maxInputBytes) {
    throw new StatsEngineInputTooLargeError(`serialized input (${byteLength} bytes) exceeds maxInputBytes(${config.stats.maxInputBytes})`);
  }
}


// §4단계 응답 계약 "행 단위 예측은 Node까지만 간다" — 4MiB(계획서 "2MiB 상한
// 충돌 → 4MiB와 실제 바이트 사전검사"). config.stats.maxInputBytes(기본
// 2MiB)를 그대로 쓰지 않는다 — outerFolds가 R×N 정수 배열이라(repeats=5,
// maxRows=5000이면 25,000개) 일반 분석 요청보다 payload가 커진다.
const PREDICTION_MAX_INPUT_BYTES = 4 * 1024 * 1024;

export function assertPredictionWithinLimits(request: PredictionEngineRequest): void {
  const n = request.y.length;
  const p = request.columnNames.length;
  if (n > MAX_VALUES_PER_VARIABLE) {
    throw new StatsEngineInputTooLargeError(`prediction 행 수(${n})가 상한(${MAX_VALUES_PER_VARIABLE})을 초과`);
  }
  const total = n * p;
  if (total > MAX_TOTAL_VALUES) {
    throw new StatsEngineInputTooLargeError(`prediction 전체 값 개수(N×P=${total})가 상한(${MAX_TOTAL_VALUES})을 초과`);
  }
  const byteLength = Buffer.byteLength(
    JSON.stringify({ protocolVersion: ENGINE_PROTOCOL_VERSION, prediction: request }), 'utf8',
  );
  if (byteLength > PREDICTION_MAX_INPUT_BYTES) {
    throw new StatsEngineInputTooLargeError(`serialized prediction input (${byteLength} bytes) exceeds PREDICTION_MAX_INPUT_BYTES(${PREDICTION_MAX_INPUT_BYTES})`);
  }
}
