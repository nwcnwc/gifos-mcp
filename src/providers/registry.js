// What gifos-mcp offers the Meet Bot. The four roles run on this machine.
// API keys are read from the environment at call time and are not part of
// the registration the bot is shown.

export const ROLES = [
  { role: 'stt', engine: 'whisper', where: 'provider' },
  { role: 'tts', engine: 'kokoro', where: 'provider' },
  { role: 'llm', engine: 'openai-compatible', where: 'provider' },
  { role: 'say', engine: 'grok-bot', where: 'provider' },
];

export function providerRegistration() {
  return {
    v: 1,
    op: 'providers',
    roles: ROLES.map((r) => ({ role: r.role, engine: r.engine, where: r.where })),
  };
}

// Safe to put in tool output and in the admin-room announcement.
export function providerPublic(env = {}) {
  return {
    roles: providerRegistration().roles,
    llm_configured: !!String(env.GIFOS_LLM_URL || '').trim(),
    keys: 'on-provider',
  };
}
