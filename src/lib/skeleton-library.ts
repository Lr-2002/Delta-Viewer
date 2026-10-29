import type { SkeletonLibraryInfo } from '../types';
export const MODEL_LIBRARY_ENABLED = 'delta.skeleton-library.enabled';
export function modelLibraryEnabled(): boolean {
  try { return localStorage.getItem(MODEL_LIBRARY_ENABLED) === '1'; } catch { return false; }
}
export function modelCandidate(path: string, info: SkeletonLibraryInfo | null): boolean {
  const plain = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const windows=/^(?:[A-Za-z]:|\/\/)/.test(plain);
  return Boolean(info?.relatives.some(relative => windows ? plain.toLowerCase().endsWith('/'+relative.toLowerCase()) : plain.endsWith('/' + relative)));
}

/** Only confirmed parent-directory aliases are used, never a same-name guess. */
export function modelEpisodeCandidate(path: string, info: SkeletonLibraryInfo | null, parents: Record<string, string>): boolean {
  if (modelCandidate(path, info)) return true;
  const plain = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const at = plain.lastIndexOf('/');
  const previous = parents[plain.slice(0, at)];
  return Boolean(previous && modelCandidate(previous.replaceAll('\\', '/') + plain.slice(at), info));
}
