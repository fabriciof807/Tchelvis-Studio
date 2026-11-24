export type MediaKind = 'image' | 'model3d';

export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'bmp',
  'ico',
  'avif',
]);

export const MODEL_3D_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'stl', 'fbx']);

export function getFileExtension(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? '';
  const base = clean.split('/').pop() ?? '';
  const idx = base.lastIndexOf('.');
  if (idx < 0 || idx === base.length - 1) return '';
  return base.slice(idx + 1).toLowerCase();
}

export function getMediaKind(path: string): MediaKind | null {
  const ext = getFileExtension(path);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (MODEL_3D_EXTENSIONS.has(ext)) return 'model3d';
  return null;
}

export function getMimeTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'ico':
      return 'image/x-icon';
    case 'avif':
      return 'image/avif';
    case 'glb':
      return 'model/gltf-binary';
    case 'gltf':
      return 'model/gltf+json';
    default:
      return 'application/octet-stream';
  }
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
