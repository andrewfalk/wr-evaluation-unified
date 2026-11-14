// @ts-nocheck
import { isIntranetContext } from '../../platform/dataMode';
export function isIntranetWorkspaceMode({ session, settings } = {}) {
  return isIntranetContext({ session, settings });
}

export function shouldUseWorkspaceAutosave({ disabled = false, session, settings } = {}) {
  return !disabled && !isIntranetWorkspaceMode({ session, settings });
}
