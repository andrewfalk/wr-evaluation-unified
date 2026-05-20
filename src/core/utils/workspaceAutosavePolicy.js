export function isIntranetWorkspaceMode({ session, settings } = {}) {
  return session?.mode === 'intranet' || settings?.integrationMode === 'intranet';
}

export function shouldUseWorkspaceAutosave({ disabled = false, session, settings } = {}) {
  return !disabled && !isIntranetWorkspaceMode({ session, settings });
}
