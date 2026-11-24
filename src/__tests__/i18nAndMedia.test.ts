import { describe, expect, it, vi, afterEach } from 'vitest';
import { detectSystemLocale, normalizeLocale, translate } from '../i18n';
import { getFileExtension, getMediaKind, getMimeTypeForExt } from '../panels/mediaUtils';

describe('i18n locale detection and translation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes Portuguese, Chinese, and English system locales', () => {
    expect(normalizeLocale('pt-BR')).toBe('pt-BR');
    expect(normalizeLocale('pt-PT')).toBe('pt-BR');
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hans')).toBe('zh-CN');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr-FR')).toBe('en');
  });

  it('detects initial locale from navigator.languages', () => {
    vi.stubGlobal('navigator', { languages: ['zh-CN', 'en-US'], language: 'en-US' });
    expect(detectSystemLocale()).toBe('zh-CN');

    vi.stubGlobal('navigator', { languages: ['en-GB'], language: 'en-GB' });
    expect(detectSystemLocale()).toBe('en');
  });

  it('translates Chat label across all locales without Pi Durable', () => {
    expect(translate('pt-BR', 'chat.title')).toBe('Chat');
    expect(translate('en', 'chat.title')).toBe('Chat');
    expect(translate('zh-CN', 'chat.title')).toBe('Chat');
    expect(translate('zh-CN', 'settings.title')).toBe('设置');
  });
});

describe('mediaUtils file detection', () => {
  it('classifies images, 3D models, and non-media files correctly', () => {
    expect(getFileExtension('assets/hero.PNG')).toBe('png');
    expect(getMediaKind('assets/hero.png')).toBe('image');
    expect(getMediaKind('assets/sprite.webp')).toBe('image');
    expect(getMediaKind('models/knight.glb')).toBe('model3d');
    expect(getMediaKind('models/prop.OBJ')).toBe('model3d');
    expect(getMediaKind('models/terrain.stl')).toBe('model3d');
    expect(getMediaKind('models/anim.fbx')).toBe('model3d');
    expect(getMediaKind('gdd/01-visao-geral.md')).toBeNull();
    expect(getMimeTypeForExt('glb')).toBe('model/gltf-binary');
    expect(getMimeTypeForExt('svg')).toBe('image/svg+xml');
  });
});
