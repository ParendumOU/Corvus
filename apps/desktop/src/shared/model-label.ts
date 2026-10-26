/** A model id as people read it: "claude-opus-5-5" → "Opus 5.5"; other ids as they are. */
export function modelLabel(model: string): string {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  return m ? `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : model;
}
