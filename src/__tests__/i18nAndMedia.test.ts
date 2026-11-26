import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  detectSystemLocale,
  normalizeLocale,
  translate,
  translatePlural,
  translations,
  type TranslationKey,
} from '../i18n';
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

describe('provider dialog copy (S3)', () => {
  /** Every `providerDialog.*` key from spec §3.6, without the namespace prefix. */
  const PROVIDER_DIALOG_KEYS = [
    'title',
    'subtitle',
    'close',
    'searchPlaceholder',
    'listLabel',
    'sectionConnected',
    'sectionAvailable',
    'methodKey',
    'methodSignIn',
    'kindApiKey',
    'kindSignedIn',
    'kindEnv',
    'noMatch',
    'otherProvider',
    'otherProviderTitle',
    'slugLabel',
    'slugPlaceholder',
    'slugInvalid',
    'keyLabel',
    'keyPlaceholder',
    'envHelper',
    'useSignIn',
    'useKey',
    'connect',
    'connecting',
    'checking',
    'signInHint',
    'signIn',
    'waiting',
    'waitingBtn',
    'checkNow',
    'showTerminal',
    'cancelSignIn',
    'signInTimeout',
    'checkAgain',
    'reopenTerminal',
    'statusApiKey',
    'statusSignedIn',
    'statusEnv',
    'storedWhere',
    'envDisconnectNote',
    'replaceKey',
    'saveKeyInstead',
    'saveKey',
    'signInAgain',
    'cancel',
    'disconnect',
    'confirmTitle',
    'confirmBody',
    'confirmDefaultFallback',
    'confirmDefaultNone',
    'confirmDisconnect',
    'disconnecting',
    'disconnected',
    'stillViaEnv',
    'defaultModelLabel',
    'defaultModelLocked',
    'defaultChanged',
    'done',
    'saving',
    'useOffline',
    'piMissing',
    'errInvalid',
    'errNotReady',
    'errGeneric',
    'savedUnchecked',
  ] as const;

  const locales = ['en', 'pt-BR', 'zh-CN'] as const;

  it('defines every providerDialog key in all three locales', () => {
    for (const key of PROVIDER_DIALOG_KEYS) {
      const id = `providerDialog.${key}`;
      for (const locale of locales) {
        expect(Object.keys(translations[locale]), `${locale} is missing ${id}`).toContain(id);
        expect(
          (translations[locale] as Record<string, string>)[id],
          `${locale} has empty copy for ${id}`
        ).not.toBe('');
      }
    }
  });

  it('uses the exact English copy from the spec', () => {
    expect(translate('en', 'providerDialog.title' as TranslationKey)).toBe(
      'Connect an AI provider'
    );
    expect(translate('en', 'providerDialog.keyPlaceholder' as TranslationKey)).toBe(
      'Paste your API key'
    );
    expect(translate('en', 'providerDialog.envHelper' as TranslationKey)).toBe(
      'Or set {envVar} in your environment.'
    );
  });

  it('defines the chat CTA and pill copy in all three locales', () => {
    for (const id of ['chat.connectCta.title', 'chat.connectCta.button', 'piSetup.pillWaiting']) {
      for (const locale of locales) {
        expect(Object.keys(translations[locale]), `${locale} is missing ${id}`).toContain(id);
        expect(
          (translations[locale] as Record<string, string>)[id],
          `${locale} has empty copy for ${id}`
        ).not.toBe('');
      }
    }
    expect(translate('en', 'chat.connectCta.title' as TranslationKey)).toBe(
      'Connect an AI provider to start'
    );
    expect(translate('en', 'chat.connectCta.button' as TranslationKey)).toBe('Connect');
    expect(translate('en', 'piSetup.pillWaiting' as TranslationKey)).toBe(
      'Waiting for sign-in\u2026'
    );
  });

  it('updates the piSetup pill and Settings copy', () => {
    expect(translate('en', 'piSetup.pillConnect')).toBe('Connect provider');
    expect(translate('pt-BR', 'piSetup.pillConnect')).toBe('Conectar provedor');
    expect(translate('zh-CN', 'piSetup.pillConnect')).toBe('连接提供商');

    expect(translate('en', 'piSetup.settingsTitle')).toBe('AI provider (Chat)');
    expect(translate('pt-BR', 'piSetup.settingsTitle')).toBe('Provedor de IA (Chat)');
    expect(translate('zh-CN', 'piSetup.settingsTitle')).toBe('AI 提供商（聊天）');

    expect(translate('en', 'piSetup.settingsDesc')).toBe(
      'Connect providers and choose the default chat model.'
    );
    expect(translate('pt-BR', 'piSetup.settingsDesc')).toBe(
      'Conecte provedores e escolha o modelo padrão do Chat.'
    );
    expect(translate('zh-CN', 'piSetup.settingsDesc')).toBe('连接提供商并选择聊天的默认模型。');

    expect(translate('en', 'piSetup.settingsConfigureBtn')).toBe('Manage providers\u2026');
    expect(translate('pt-BR', 'piSetup.settingsConfigureBtn')).toBe('Gerenciar provedores\u2026');
    expect(translate('zh-CN', 'piSetup.settingsConfigureBtn')).toBe('管理提供商\u2026');
  });

  it('drops the setup-wizard keys that the dialog replaced', () => {
    const REMOVED_KEYS = [
      'piSetup.title',
      'piSetup.subtitle',
      'piSetup.readyBanner',
      'piSetup.useDetectedBtn',
      'piSetup.providerLabel',
      'piSetup.customProviderOption',
      'piSetup.customProviderPlaceholder',
      'piSetup.configuredBadge',
      'piSetup.authApiKeyTab',
      'piSetup.authOAuthTab',
      'piSetup.apiKeyLabel',
      'piSetup.apiKeyPlaceholder',
      'piSetup.saveKeyBtn',
      'piSetup.oauthHint',
      'piSetup.openTerminalLoginBtn',
      'piSetup.verifyAuthBtn',
      'piSetup.checking',
      'piSetup.logoutBtn',
      'piSetup.modelLabel',
      'piSetup.saveConnectBtn',
      'piSetup.skipOfflineBtn',
      'piSetup.closeBtn',
      'piSetup.authReadyMsg',
      'piSetup.authNotReadyMsg',
      'piSetup.piMissingHint',
      'piSetup.chatBlockedHint',
    ];

    for (const locale of locales) {
      for (const id of REMOVED_KEYS) {
        expect(Object.keys(translations[locale]), `${locale} still has ${id}`).not.toContain(id);
      }
    }
  });

  it('never mentions Pi Durable in any locale', () => {
    for (const locale of locales) {
      for (const [key, value] of Object.entries(translations[locale] as Record<string, string>)) {
        expect(value, `${locale}:${key}`).not.toMatch(/Pi Durable/);
      }
    }
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
