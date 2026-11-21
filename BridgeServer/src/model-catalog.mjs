/**
 * ModelCatalog — Authoritative Antigravity 2.0 Model & Thinking Effort catalog,
 * plus bidirectional lookup for Desktop `<USER_SETTINGS_CHANGE>` display names
 * and `swarm` / `agentapi` model identifiers.
 */

export const MODEL_FAMILIES = [
  {
    familyId: 'gemini-4-carbon',
    familyName: 'Gemini 4 Carbon',
    shortFamily: 'Carbon',
    provider: 'google',
    variants: [
      { id: 'gemini-4-carbon-low', thinking: 'low', thinkingLabel: 'Low', displayName: 'Gemini 4 Carbon (Low)', shortLabel: 'Carbon · Low' },
      { id: 'gemini-4-carbon-medium', thinking: 'medium', thinkingLabel: 'Medium', displayName: 'Gemini 4 Carbon (Medium)', shortLabel: 'Carbon · Med' },
      { id: 'gemini-4-carbon-high', thinking: 'high', thinkingLabel: 'High', displayName: 'Gemini 4 Carbon (High)', shortLabel: 'Carbon · High' },
    ],
  },
  {
    familyId: 'gemini-4-hydrogen',
    familyName: 'Gemini 4 Hydrogen',
    shortFamily: 'Hydrogen',
    provider: 'google',
    variants: [
      { id: 'gemini-4-hydrogen-low', thinking: 'low', thinkingLabel: 'Low', displayName: 'Gemini 4 Hydrogen (Low)', shortLabel: 'Hydrogen · Low' },
      { id: 'gemini-4-hydrogen-medium', thinking: 'medium', thinkingLabel: 'Medium', displayName: 'Gemini 4 Hydrogen (Medium)', shortLabel: 'Hydrogen · Med' },
      { id: 'gemini-4-hydrogen-high', thinking: 'high', thinkingLabel: 'High', displayName: 'Gemini 4 Hydrogen (High)', shortLabel: 'Hydrogen · High' },
      { id: 'gemini-4-hydrogen-xhigh', thinking: 'xhigh', thinkingLabel: 'XHigh', displayName: 'Gemini 4 Hydrogen (XHigh)', shortLabel: 'Hydrogen · XHigh' },
    ],
  },
  {
    familyId: 'gemini-4-neon',
    familyName: 'Gemini 4 Neon',
    shortFamily: 'Neon',
    provider: 'google',
    variants: [
      { id: 'gemini-4-neon-low', thinking: 'low', thinkingLabel: 'Low', displayName: 'Gemini 4 Neon (Low)', shortLabel: 'Neon · Low' },
      { id: 'gemini-4-neon-medium', thinking: 'medium', thinkingLabel: 'Medium', displayName: 'Gemini 4 Neon (Medium)', shortLabel: 'Neon · Med' },
      { id: 'gemini-4-neon-high', thinking: 'high', thinkingLabel: 'High', displayName: 'Gemini 4 Neon (High)', shortLabel: 'Neon · High' },
      { id: 'gemini-4-neon-xhigh', thinking: 'xhigh', thinkingLabel: 'XHigh', displayName: 'Gemini 4 Neon (XHigh)', shortLabel: 'Neon · XHigh' },
    ],
  },
  {
    familyId: 'gemini-4-argon',
    familyName: 'Gemini 4 Argon',
    shortFamily: 'Argon',
    provider: 'google',
    variants: [
      { id: 'gemini-4-argon-low', thinking: 'low', thinkingLabel: 'Low', displayName: 'Gemini 4 Argon (Low)', shortLabel: 'Argon · Low' },
      { id: 'gemini-4-argon-medium', thinking: 'medium', thinkingLabel: 'Medium', displayName: 'Gemini 4 Argon (Medium)', shortLabel: 'Argon · Med' },
      { id: 'gemini-4-argon-high', thinking: 'high', thinkingLabel: 'High', displayName: 'Gemini 4 Argon (High)', shortLabel: 'Argon · High' },
    ],
  },
  {
    familyId: 'gemini-3.8-flash',
    familyName: 'Gemini 3.8 Flash',
    shortFamily: '3.8 Flash',
    provider: 'google',
    variants: [
      { id: 'gemini-3.8-flash-low', thinking: 'low', thinkingLabel: 'Low', displayName: 'Gemini 3.8 Flash (Low)', shortLabel: 'Flash · Low' },
      { id: 'gemini-3.8-flash-medium', thinking: 'medium', thinkingLabel: 'Medium', displayName: 'Gemini 3.8 Flash (Medium)', shortLabel: 'Flash · Med' },
      { id: 'gemini-3.8-flash-high', thinking: 'high', thinkingLabel: 'High', displayName: 'Gemini 3.8 Flash (High)', shortLabel: 'Flash · High' },
    ],
  },
  {
    familyId: 'orchestrator',
    familyName: 'Orchestrator',
    shortFamily: 'Orchestrator',
    provider: 'google',
    variants: [
      { id: 'gemini-pro-orchestrator', thinking: 'high', thinkingLabel: 'Carbon', displayName: 'Orchestrator (Carbon)', shortLabel: 'Orch · Carbon' },
      { id: 'gemini-pro-orchestrator-neon', thinking: 'high', thinkingLabel: 'Neon', displayName: 'Orchestrator (Neon)', shortLabel: 'Orch · Neon' },
      { id: 'gemini-pro-orchestrator-argon', thinking: 'high', thinkingLabel: 'Argon', displayName: 'Orchestrator (Argon)', shortLabel: 'Orch · Argon' },
    ],
  },
  {
    familyId: 'claude-opus-5-5',
    familyName: 'Claude Opus 5.5',
    shortFamily: 'Opus 5.5',
    provider: 'anthropic',
    variants: [
      { id: 'claude-opus-5-5-low', thinking: 'low', thinkingLabel: 'Low', displayName: 'Claude Opus 5.5 (Low)', shortLabel: 'Opus · Low' },
      { id: 'claude-opus-5-5-medium', thinking: 'medium', thinkingLabel: 'Medium', displayName: 'Claude Opus 5.5 (Medium)', shortLabel: 'Opus · Med' },
      { id: 'claude-opus-5-5-high', thinking: 'high', thinkingLabel: 'High', displayName: 'Claude Opus 5.5 (High)', shortLabel: 'Opus · High' },
    ],
  },
  {
    familyId: 'claude-sonnet-5-5',
    familyName: 'Claude Sonnet 5.5',
    shortFamily: 'Sonnet 5.5',
    provider: 'anthropic',
    variants: [
      { id: 'claude-sonnet-5-5-low', thinking: 'low', thinkingLabel: 'Low', displayName: 'Claude Sonnet 5.5 (Low)', shortLabel: 'Sonnet · Low' },
      { id: 'claude-sonnet-5-5-medium', thinking: 'medium', thinkingLabel: 'Medium', displayName: 'Claude Sonnet 5.5 (Medium)', shortLabel: 'Sonnet · Med' },
      { id: 'claude-sonnet-5-5-high', thinking: 'high', thinkingLabel: 'High', displayName: 'Claude Sonnet 5.5 (High)', shortLabel: 'Sonnet · High' },
    ],
  },
  {
    familyId: 'gpt-oss-120b',
    familyName: 'GPT-OSS 120B',
    shortFamily: 'GPT-OSS',
    provider: 'oss',
    variants: [
      { id: 'gpt-oss-120b-medium', thinking: 'medium', thinkingLabel: 'Medium', displayName: 'GPT-OSS 120B (Medium)', shortLabel: 'GPT-OSS · Med' },
    ],
  },
];

const BY_ID = new Map();
const BY_DISPLAY_LOWER = new Map();

for (const fam of MODEL_FAMILIES) {
  for (const v of fam.variants) {
    const record = {
      ...v,
      familyId: fam.familyId,
      familyName: fam.familyName,
      shortFamily: fam.shortFamily,
      provider: fam.provider,
    };
    BY_ID.set(v.id.toLowerCase(), record);
    BY_DISPLAY_LOWER.set(v.displayName.toLowerCase(), record);
  }
}

export function lookupModelInfo(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const clean = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!clean || clean === 'inherit' || clean === 'default' || clean === 'None') return null;
  const lower = clean.toLowerCase();
  if (BY_ID.has(lower)) return BY_ID.get(lower);
  if (BY_DISPLAY_LOWER.has(lower)) return BY_DISPLAY_LOWER.get(lower);
  if (lower === 'pro') return BY_ID.get('gemini-4-carbon-high') || null;
  if (lower === 'flash') return BY_ID.get('gemini-3.8-flash-high') || null;
  if (lower === 'flash_lite') return BY_ID.get('gemini-3.8-flash-low') || null;
  return {
    id: clean,
    thinking: 'high',
    thinkingLabel: 'Default',
    displayName: clean,
    shortLabel: clean.length > 18 ? clean.slice(0, 18) : clean,
    familyId: 'custom',
    familyName: clean,
    shortFamily: clean,
    provider: 'google',
  };
}
