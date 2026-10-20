export function assistantCardSources(contract = {}) {
  const raw = Array.isArray(contract.terminalCardSources) ? contract.terminalCardSources : contract.cardSources;
  if (Array.isArray(raw) && raw.length) return raw;
  const className = String(contract.primaryClass || contract.className || '').trim();
  return className ? [{ id: 'current', className, classColumn: 'Class', idColumn: '_id', label: 'Карточка результата' }] : [];
}

export function assistantSelectedCardSource(contract = {}, cardSourceId = '', descriptor = null) {
  const sources = assistantCardSources(contract);
  const requested = String(cardSourceId || descriptor && descriptor.id || '').trim();
  const candidates = requested ? sources.filter((source) => String(source && source.id || '') === requested) : sources;
  const source = candidates.length === 1 && (requested || sources.length === 1) ? candidates[0] : null;
  const valid = source && source.id && source.className && source.classColumn && source.idColumn && (!descriptor ||
    ['className', 'classColumn', 'idColumn'].every((key) => String(descriptor[key] || '') === String(source[key] || '')));
  return {
    source: valid ? source : null,
    inferred: Boolean(valid && !requested),
    ambiguous: !requested && sources.length > 1,
    invalid: Boolean(requested && !valid)
  };
}

export function assistantMergeBindingIntent(seed, response) {
  const pendingPlacements = new Set(seed.pendingPlacementIds);
  const pendingConnections = new Set(seed.pendingConnectionKeys);
  const placements = Array.isArray(response.placementBindings) ? response.placementBindings : [];
  const connections = Array.isArray(response.connectionBindings) ? response.connectionBindings : [];
  const unresolved = Array.isArray(response.unresolved) ? response.unresolved : [];
  const requestedUnresolved = unresolved.filter((item) => item && (item.targetType === 'placement'
    ? pendingPlacements.has(String(item.targetId || ''))
    : item.targetType === 'connection' && pendingConnections.has(String(item.targetId || ''))));
  // A seed fixes deterministic choices, not the pending natural-language obligations.
  // Pending targets must come from the response, including omissions and unresolved.
  const requestedPlacements = placements.filter((item) => pendingPlacements.has(String(item && item.structureItemId || '')));
  const requestedConnections = connections.filter((item) => pendingConnections.has(String(item && item.d2ClassKey || '')));
  return {
    ...response,
    placementBindings: seed.placementBindings.filter((item) => !pendingPlacements.has(String(item.structureItemId || ''))).concat(requestedPlacements),
    connectionBindings: seed.connectionBindings.filter((item) => !pendingConnections.has(String(item.d2ClassKey || ''))).concat(requestedConnections),
    unresolved: requestedUnresolved,
    ignoredResponseItems: placements.length + connections.length + unresolved.length - requestedPlacements.length - requestedConnections.length - requestedUnresolved.length
  };
}
