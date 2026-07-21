export function sanitizeProtect(value) {
  return {
    host: typeof value?.host === 'string' ? value.host.trim() : undefined,
    username: typeof value?.username === 'string' ? value.username : undefined,
    password: typeof value?.password === 'string' ? value.password : undefined,
    ignoreTls: typeof value?.ignoreTls === 'boolean' ? value.ignoreTls : undefined,
  };
}

export function applyProtectControllerFallback(direct, controller) {
  return {
    host: direct.host ?? controller?.address,
    username: direct.username ?? controller?.username,
    password: direct.password ?? controller?.password,
    ignoreTls: direct.ignoreTls ?? true,
  };
}
