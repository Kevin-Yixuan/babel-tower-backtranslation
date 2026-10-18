export function ownRecordMap(value = {}) {
  return Object.assign(Object.create(null), value);
}

export function stableJson(value) {
  const ordered = item => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])]));
    return item;
  };
  return JSON.stringify(ordered(value));
}
