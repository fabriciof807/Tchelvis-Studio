import { describe, expect, it, vi, afterEach } from 'vitest';
import { detectSystemLocale, normalizeLocale, translate, translatePlural, translations } from '../i18n';
import { getFileExtension, getMediaKind, getMimeTypeForExt } from '../panels/mediaUtils';
import { isThemeId, THEME_OPTIONS } from '../themes';

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

describe('i18n key parity and plurals', () => {
  it('defines exactly the same keys in every locale', () => {
    const reference = Object.keys(translations.en).sort();
    expect(Object.keys(translations['pt-BR']).sort()).toEqual(reference);
    expect(Object.keys(translations['zh-CN']).sort()).toEqual(reference);
  });

  it('picks _one/_other with Intl.PluralRules for the active locale', () => {
    expect(translatePlural('en', 'modelPicker.modelCount', 1)).toBe('1 model');
    expect(translatePlural('en', 'modelPicker.modelCount', 34)).toBe('34 models');
    expect(translatePlural('pt-BR', 'modelPicker.modelCount', 1)).toBe('1 modelo');
    expect(translatePlural('pt-BR', 'modelPicker.modelCount', 2)).toBe('2 modelos');
    expect(translatePlural('zh-CN', 'modelPicker.modelCount', 1)).toBe('1 个模型');
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

describe('themes', () => {
  it('provides all 4 standard themes', () => {
    const ids = THEME_OPTIONS.map((t) => t.id);
    expect(ids).toEqual(['tokyo-night', 'gruvbox', 'kanagawa', 'github-dark']);
    expect(isThemeId('tokyo-night')).toBe(true);
    expect(isThemeId('gruvbox')).toBe(true);
    expect(isThemeId('kanagawa')).toBe(true);
    expect(isThemeId('github-dark')).toBe(true);
    expect(isThemeId('unknown')).toBe(false);
  });
});
