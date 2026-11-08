// Recipe checks on the variables themselves: existence, identifiers, filter-only, purpose, Table1 group
// variable type, formula policies.
// Split out of stats/recipe/validation.ts (S6 P1-35); check bodies unchanged.
import { isPurposeCompatible } from '@wr/analytics-core';
import { isGroupingType } from './methods';
import type { RecipeCheckInput } from '.';

export function checkKeysExist(input: RecipeCheckInput): void {
  const { catalogByKey, neededKeys, errors } = input;
  // §A-2 키 존재
  for (const key of neededKeys) {
    if (!catalogByKey.has(key)) {
      errors.push({ code: 'UNKNOWN_VARIABLE', path: key, message: `카탈로그에 없는 변수 key: ${key}` });
    }
  }
}

export function checkVariableRules(input: RecipeCheckInput): void {
  const { recipe, catalogByKey, neededKeys, stratifyByKey, errors } = input;
  // §A-3 식별자 제한(방어적 — 현재 카탈로그엔 direct_identifier가 0건)
  for (const key of neededKeys) {
    const variable = catalogByKey.get(key);
    if (variable && variable.sensitivity === 'direct_identifier') {
      errors.push({ code: 'IDENTIFIER_NOT_ALLOWED', path: key, message: `직접식별자 변수는 어떤 grain에서도 사용할 수 없다: ${key}` });
    }
  }

  // PR0-B3 Part C — 필터 전용 변수 계약. filter_only 변수(예: 등록일)는 filters[]에서만
  // 쓸 수 있고 variableKeys(분석 대상)에는 올 수 없다 — grain 검사와 별개 축이라 위
  // VARIABLE_GRAIN_MISMATCH 검사와 독립적으로 검사한다. Table1의 stratifyByKey도
  // "분석 대상 변수 자리"의 일종이라 같은 규칙을 적용한다.
  for (const key of stratifyByKey ? [...recipe.variableKeys, stratifyByKey] : recipe.variableKeys) {
    const variable = catalogByKey.get(key);
    if (variable && variable.analysisRole === 'filter_only') {
      errors.push({
        code: 'FILTER_ONLY_VARIABLE_NOT_ANALYZABLE',
        path: key,
        message: `${key}는 필터 전용 변수라 분석 변수(variableKeys)로 쓸 수 없다 — 필터로만 사용하라`,
      });
    }
  }

  // §A-4 분석 목적 — variableKeys + stratifyByKey(필터는 대상이 아님)
  for (const key of stratifyByKey ? [...recipe.variableKeys, stratifyByKey] : recipe.variableKeys) {
    const variable = catalogByKey.get(key);
    if (variable && !isPurposeCompatible(variable, recipe.analysisPurpose)) {
      errors.push({
        code: 'PURPOSE_NOT_ALLOWED',
        path: key,
        message: `${key}는 analysisPurpose "${recipe.analysisPurpose}"를 허용하지 않는다(허용: ${variable.allowedAnalysisPurposes.join(', ')})`,
      });
    }
  }

  // Table1 — 그룹 변수는 boolean/ordinal/categorical만 허용(continuous/high_cardinality/
  // date는 그룹 축으로 쓸 수 없다 — 이 파일의 기존 isGroupingType 재사용, stats/dataset/bivariateRoles.ts의
  // 동명 함수와 동일 규칙). 존재하지 않는 키는 위 UNKNOWN_VARIABLE로 이미 보고됐으므로 여기선 스킵.
  if (stratifyByKey) {
    const variable = catalogByKey.get(stratifyByKey);
    if (variable && !isGroupingType(variable.type)) {
      errors.push({
        code: 'STRATIFY_KEY_TYPE_UNSUPPORTED',
        path: 'descriptive.stratifyByKey',
        message: `${stratifyByKey}는 type "${variable.type}"라 그룹 변수로 쓸 수 없다(허용: boolean/ordinal/categorical)`,
      });
    }
  }
}

export function checkFormulaPolicies(input: RecipeCheckInput): void {
  const { recipe, catalogByKey, neededKeys, errors } = input;
  // §A-8 formulaPolicy 유효성 — family 단위로 한 번씩만 검사(중복 에러 방지).
  const checkedFamilies = new Set<string>();
  for (const key of neededKeys) {
    const variable = catalogByKey.get(key);
    if (!variable) continue;
    const { formulaFamily, supportedFormulaPolicies } = variable;
    if (checkedFamilies.has(formulaFamily)) continue;
    checkedFamilies.add(formulaFamily);

    const declaredPolicy = recipe.formulaPolicies[formulaFamily];
    if (supportedFormulaPolicies.length > 1) {
      if (declaredPolicy === undefined) {
        errors.push({
          code: 'FORMULA_POLICY_REQUIRED',
          path: `formulaPolicies.${formulaFamily}`,
          message: `formula family "${formulaFamily}"는 정책이 혼재하므로 formulaPolicies.${formulaFamily}를 명시해야 한다(가능: ${supportedFormulaPolicies.join(', ')})`,
        });
      } else if (!supportedFormulaPolicies.includes(declaredPolicy)) {
        errors.push({
          code: 'UNSUPPORTED_FORMULA_POLICY',
          path: `formulaPolicies.${formulaFamily}`,
          message: `formula family "${formulaFamily}"는 정책 "${declaredPolicy}"를 지원하지 않는다(가능: ${supportedFormulaPolicies.join(', ')})`,
        });
      }
    } else if (declaredPolicy !== undefined && !supportedFormulaPolicies.includes(declaredPolicy)) {
      errors.push({
        code: 'UNSUPPORTED_FORMULA_POLICY',
        path: `formulaPolicies.${formulaFamily}`,
        message: `formula family "${formulaFamily}"는 정책 "${declaredPolicy}"를 지원하지 않는다(가능: ${supportedFormulaPolicies.join(', ')})`,
      });
    }
  }
}
