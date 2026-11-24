export type Locale = 'pt-BR' | 'en' | 'zh-CN';

export const LOCALE_STORAGE_KEY = 'game-hub:locale';

export const LOCALE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
];

export function normalizeLocale(raw: string | null | undefined): Locale {
  if (!raw) return 'en';
  const lower = raw.toLowerCase();
  if (lower.startsWith('pt')) return 'pt-BR';
  if (lower.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'pt-BR';
  const candidates =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const cand of candidates) {
    if (cand) return normalizeLocale(cand);
  }
  return 'en';
}

export function getInitialLocale(): Locale {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (saved === 'pt-BR' || saved === 'en' || saved === 'zh-CN') {
        return saved;
      }
    } catch {
      // ignore storage errors
    }
  }
  return detectSystemLocale();
}

export const translations = {
  'pt-BR': {
    // Welcome & App
    'app.subtitle': 'Estúdio Local-First de Game Design & Orquestração',
    'app.welcomeDesc':
      'Selecione uma pasta pelo navegador do sistema, escolha um projeto recente ou informe o caminho manualmente.',
    'app.pickFolder': 'Escolher Pasta...',
    'app.opening': 'Abrindo...',
    'app.open': 'Abrir',
    'app.pathPlaceholder': '/caminho/para/meu-jogo',
    'app.recentProjects': 'Projetos Recentes',
    'app.noRecentProjects': 'Nenhum projeto recente registrado.',
    'app.settings': 'Configurações',
    'app.settingsTooltip': 'Configurações e Atualizações',

    // Presets Bar & Activity Bar
    'bar.layoutPreset': 'Layout Preset...',
    'bar.defaultLayout': 'Padrão',
    'bar.zenMode': 'Zen Mode',
    'bar.exitZen': 'Sair do Zen',
    'bar.toggleZenTooltip': 'Alternar Zen Mode',
    'bar.preview': 'Preview (F5)',
    'bar.previewActive': 'Preview Ativo (F5)',
    'bar.previewTooltip': 'Preview Flutuante (F5)',
    'bar.switchProject': 'Trocar Projeto',

    'activity.explorer': 'Explorador de Arquivos (Ctrl+B)',
    'activity.loops': 'Loops (Tchelvis-Supervisor)',
    'activity.lenses': 'Lentes Customizadas (.hub/views/)',
    'activity.preview': 'Preview Flutuante (F5)',
    'activity.terminal': 'Terminal Inferior (Ctrl+J)',
    'activity.chat': 'Chat (Ctrl+L)',
    'activity.settings': 'Configurações e Atualizações',

    // Drawers
    'drawer.explorer': 'EXPLORADOR',
    'drawer.refreshTree': 'Atualizar árvore',
    'drawer.emptyWorkspace': 'Workspace vazio',
    'drawer.unsaved': 'Não salvo',
    'drawer.loops': 'LOOPS (TCHELVIS)',
    'drawer.noLoops': 'Nenhum loop executado.',
    'drawer.lenses': 'LENTES (.hub/views/)',
    'drawer.noLenses': 'Nenhuma lente publicada.',
    'drawer.terminal': 'TERMINAL',
    'drawer.collapseTerminal': 'Recolher Terminal (Ctrl+J)',
    'drawer.resizeLeft': 'Arrastar para redimensionar painel esquerdo',
    'drawer.resizeRight': 'Arrastar para redimensionar chat',
    'drawer.resizeBottom': 'Arrastar para redimensionar terminal',

    // Chat Panel (renamed from Pi Durable to Chat)
    'chat.title': 'Chat',
    'chat.subtitle': 'Assistente do Projeto',
    'chat.dirtyFiles': '{count} arquivo(s) não salvo(s) no contexto',
    'chat.quotaExceeded':
      'Cota de .hub/captures/ (200 MiB) excedida. Considere limpar capturas antigas.',
    'chat.empty':
      'Converse no Chat sobre GDD, worldbuilding ou despache loops de código. Cole imagens com Ctrl+V para anexar capturas one-shot.',
    'chat.roleUser': 'Você',
    'chat.roleAssistant': 'Chat',
    'chat.roleSystem': 'Sistema',
    'chat.offlineMode': 'offline',
    'chat.removeAttachment': 'Remover anexo',
    'chat.placeholder': 'Mensagem no Chat... (Ctrl+V para colar imagem)',
    'chat.addImage': '+ Imagem',
    'chat.send': 'Enviar',
    'chat.sending': 'Enviando...',
    'chat.sendError': 'Erro ao enviar mensagem no Chat: {error}',

    // Settings Modal
    'settings.title': 'Configurações',
    'settings.close': 'Fechar (Esc)',
    'settings.languageTitle': 'Idioma',
    'settings.languageDesc': 'Escolha o idioma exibido na interface do aplicativo.',
    'settings.languageLabel': 'Idioma da interface',
    'settings.updatesTitle': 'Atualizações (CI/CD & GitHub)',
    'settings.updatesDesc':
      'Escolha o canal de atualização, verifique novas builds no GitHub e atualize o aplicativo.',
    'settings.channelLabel': 'Canal:',
    'settings.channelStable': 'Stable',
    'settings.channelNightly': 'Nightly (Bleeding Edge)',
    'settings.channelStableDesc': 'Versões verificadas e estáveis, com atualizações maiores e mais espaçadas.',
    'settings.channelNightlyDesc': 'Builds contínuas diretamente do desenvolvimento mais recente.',
    'settings.sourceRelease': 'Release CI/CD',
    'settings.sourceGit': 'Branch Git',
    'settings.checkUpdates': 'Procurar Atualizações',
    'settings.checking': 'Verificando...',
    'settings.applyUpdate': 'Atualizar Agora',
    'settings.updating': 'Atualizando...',
    'settings.branch': 'Branch:',
    'settings.local': 'Local:',
    'settings.remote': 'Remoto:',
    'settings.repo': 'Repositório:',
    'settings.updatesAvailable': '{count} atualização(ões) disponível(is):',
    'settings.upToDate': 'Você já está na versão mais recente.',
    'settings.viewLog': 'Ver log da atualização',

    // Media Viewer (Images & 3D Models)
    'media.loading': 'Carregando arquivo...',
    'media.imageMode': 'Imagem',
    'media.modelMode': 'Modelo 3D',
    'media.zoomOut': 'Diminuir zoom',
    'media.zoomIn': 'Aumentar zoom',
    'media.fit': 'Ajustar',
    'media.checkerboard': 'Fundo Xadrez',
    'media.resetCamera': 'Resetar Câmera',
    'media.grid': 'Grade',
    'media.wireframe': 'Wireframe',
    'media.autoRotate': 'Girar',
    'media.stats': '{meshes} malha(s) · {triangles} triângulos',
    'media.webglUnsupported': 'Não foi possível iniciar o contexto WebGL para exibir o modelo 3D.',
    'media.unsupportedFormat': 'Formato não suportado para visualização: {ext}',
    'media.dragHint': 'Arraste para orbitar · Scroll para zoom · Botão direito para mover',

    // Preview Lightbox
    'preview.ariaLabel': 'Preview do Jogo',
    'preview.openExternal': 'Abrir no Navegador Externo',
    'preview.captureFrame': 'Capturar Frame + Log',
    'preview.stop': 'Parar Preview',
    'preview.close': 'Fechar',
    'preview.activeMode': 'Preview ativo em modo {mode}.',
    'preview.waitingUrl': 'Aguardando URL do servidor...',

    // Markdown / Loops / Lens
    'md.loading': 'Carregando {path}...',
    'md.save': 'Salvar (Ctrl+S)',
    'md.saving': 'Salvando...',
    'md.saved': 'Salvo',
    'md.editor': 'Editor',
    'md.split': 'Split',
    'md.preview': 'Preview',
    'md.externalConflict':
      'Este arquivo foi alterado no disco externamente enquanto há edições locais não salvas.',
    'md.reloadFromDisk': 'Recarregar do disco',
    'md.keepBuffer': 'Manter meu buffer',
    'md.collisionTitle': 'Múltiplas notas correspondem a [[{target}]]:',
    'md.cancel': 'Cancelar',
    'loops.empty': 'Nenhum loop do Tchelvis encontrado em .loops/runs/.',
    'lens.loading': 'Carregando lente {id}...',
    'lens.reload': 'Recarregar',
  },
  en: {
    // Welcome & App
    'app.subtitle': 'Local-First Game Design & Agent Orchestration Studio',
    'app.welcomeDesc':
      'Pick a folder with your system browser, select a recent project, or enter a path manually.',
    'app.pickFolder': 'Choose Folder...',
    'app.opening': 'Opening...',
    'app.open': 'Open',
    'app.pathPlaceholder': '/path/to/my-game',
    'app.recentProjects': 'Recent Projects',
    'app.noRecentProjects': 'No recent projects recorded.',
    'app.settings': 'Settings',
    'app.settingsTooltip': 'Settings & Updates',

    // Presets Bar & Activity Bar
    'bar.layoutPreset': 'Layout Preset...',
    'bar.defaultLayout': 'Default',
    'bar.zenMode': 'Zen Mode',
    'bar.exitZen': 'Exit Zen',
    'bar.toggleZenTooltip': 'Toggle Zen Mode',
    'bar.preview': 'Preview (F5)',
    'bar.previewActive': 'Preview Active (F5)',
    'bar.previewTooltip': 'Floating Preview (F5)',
    'bar.switchProject': 'Switch Project',

    'activity.explorer': 'File Explorer (Ctrl+B)',
    'activity.loops': 'Loops (Tchelvis-Supervisor)',
    'activity.lenses': 'Custom Lenses (.hub/views/)',
    'activity.preview': 'Floating Preview (F5)',
    'activity.terminal': 'Bottom Terminal (Ctrl+J)',
    'activity.chat': 'Chat (Ctrl+L)',
    'activity.settings': 'Settings & Updates',

    // Drawers
    'drawer.explorer': 'EXPLORER',
    'drawer.refreshTree': 'Refresh tree',
    'drawer.emptyWorkspace': 'Empty workspace',
    'drawer.unsaved': 'Unsaved',
    'drawer.loops': 'LOOPS (TCHELVIS)',
    'drawer.noLoops': 'No loop runs yet.',
    'drawer.lenses': 'LENSES (.hub/views/)',
    'drawer.noLenses': 'No published lenses.',
    'drawer.terminal': 'TERMINAL',
    'drawer.collapseTerminal': 'Collapse Terminal (Ctrl+J)',
    'drawer.resizeLeft': 'Drag to resize left panel',
    'drawer.resizeRight': 'Drag to resize chat panel',
    'drawer.resizeBottom': 'Drag to resize terminal',

    // Chat Panel
    'chat.title': 'Chat',
    'chat.subtitle': 'Project Assistant',
    'chat.dirtyFiles': '{count} unsaved file(s) in context',
    'chat.quotaExceeded':
      '.hub/captures/ quota (200 MiB) exceeded. Consider cleaning up old captures.',
    'chat.empty':
      'Use Chat to discuss GDD, worldbuilding, or dispatch code loops. Paste images with Ctrl+V to attach one-shot captures.',
    'chat.roleUser': 'You',
    'chat.roleAssistant': 'Chat',
    'chat.roleSystem': 'System',
    'chat.offlineMode': 'offline',
    'chat.removeAttachment': 'Remove attachment',
    'chat.placeholder': 'Message Chat... (Ctrl+V to paste image)',
    'chat.addImage': '+ Image',
    'chat.send': 'Send',
    'chat.sending': 'Sending...',
    'chat.sendError': 'Failed to send Chat message: {error}',

    // Settings Modal
    'settings.title': 'Settings',
    'settings.close': 'Close (Esc)',
    'settings.languageTitle': 'Language',
    'settings.languageDesc': 'Choose the display language for the application interface.',
    'settings.languageLabel': 'Interface language',
    'settings.updatesTitle': 'Updates (CI/CD & GitHub)',
    'settings.updatesDesc':
      'Choose an update channel, check for new GitHub builds, and update the app.',
    'settings.channelLabel': 'Channel:',
    'settings.channelStable': 'Stable',
    'settings.channelNightly': 'Nightly (Bleeding Edge)',
    'settings.channelStableDesc': 'Verified stable releases with larger, less frequent updates.',
    'settings.channelNightlyDesc': 'Continuous bleeding-edge builds from latest development.',
    'settings.sourceRelease': 'CI/CD Release',
    'settings.sourceGit': 'Git Branch',
    'settings.checkUpdates': 'Check for Updates',
    'settings.checking': 'Checking...',
    'settings.applyUpdate': 'Update Now',
    'settings.updating': 'Updating...',
    'settings.branch': 'Branch:',
    'settings.local': 'Local:',
    'settings.remote': 'Remote:',
    'settings.repo': 'Repository:',
    'settings.updatesAvailable': '{count} update(s) available:',
    'settings.upToDate': 'You are already on the latest version.',
    'settings.viewLog': 'View update log',

    // Media Viewer
    'media.loading': 'Loading file...',
    'media.imageMode': 'Image',
    'media.modelMode': '3D Model',
    'media.zoomOut': 'Zoom out',
    'media.zoomIn': 'Zoom in',
    'media.fit': 'Fit',
    'media.checkerboard': 'Checkerboard',
    'media.resetCamera': 'Reset Camera',
    'media.grid': 'Grid',
    'media.wireframe': 'Wireframe',
    'media.autoRotate': 'Auto-Rotate',
    'media.stats': '{meshes} mesh(es) · {triangles} triangles',
    'media.webglUnsupported': 'Could not initialize a WebGL context to render the 3D model.',
    'media.unsupportedFormat': 'Unsupported preview format: {ext}',
    'media.dragHint': 'Drag to orbit · Scroll to zoom · Right-drag to pan',

    // Preview Lightbox
    'preview.ariaLabel': 'Game Preview',
    'preview.openExternal': 'Open in External Browser',
    'preview.captureFrame': 'Capture Frame + Log',
    'preview.stop': 'Stop Preview',
    'preview.close': 'Close',
    'preview.activeMode': 'Preview active in {mode} mode.',
    'preview.waitingUrl': 'Waiting for server URL...',

    // Markdown / Loops / Lens
    'md.loading': 'Loading {path}...',
    'md.save': 'Save (Ctrl+S)',
    'md.saving': 'Saving...',
    'md.saved': 'Saved',
    'md.editor': 'Editor',
    'md.split': 'Split',
    'md.preview': 'Preview',
    'md.externalConflict':
      'This file changed externally on disk while you have unsaved local edits.',
    'md.reloadFromDisk': 'Reload from disk',
    'md.keepBuffer': 'Keep my buffer',
    'md.collisionTitle': 'Multiple notes match [[{target}]]:',
    'md.cancel': 'Cancel',
    'loops.empty': 'No Tchelvis runs found in .loops/runs/.',
    'lens.loading': 'Loading lens {id}...',
    'lens.reload': 'Reload',
  },
  'zh-CN': {
    // Welcome & App
    'app.subtitle': '本地优先的游戏设计与智能体编排工作室',
    'app.welcomeDesc': '通过系统文件选择器挑选目录、打开最近项目或手动输入路径。',
    'app.pickFolder': '选择文件夹...',
    'app.opening': '正在打开...',
    'app.open': '打开',
    'app.pathPlaceholder': '/path/to/my-game',
    'app.recentProjects': '最近项目',
    'app.noRecentProjects': '暂无最近项目记录。',
    'app.settings': '设置',
    'app.settingsTooltip': '设置与更新',

    // Presets Bar & Activity Bar
    'bar.layoutPreset': '布局预设...',
    'bar.defaultLayout': '默认',
    'bar.zenMode': '专注模式',
    'bar.exitZen': '退出专注',
    'bar.toggleZenTooltip': '切换专注模式',
    'bar.preview': '预览 (F5)',
    'bar.previewActive': '预览运行中 (F5)',
    'bar.previewTooltip': '浮动预览 (F5)',
    'bar.switchProject': '切换项目',

    'activity.explorer': '文件浏览器 (Ctrl+B)',
    'activity.loops': '循环任务 (Tchelvis)',
    'activity.lenses': '自定义视图 (.hub/views/)',
    'activity.preview': '浮动预览 (F5)',
    'activity.terminal': '底部终端 (Ctrl+J)',
    'activity.chat': 'Chat (Ctrl+L)',
    'activity.settings': '设置与更新',

    // Drawers
    'drawer.explorer': '文件浏览器',
    'drawer.refreshTree': '刷新目录树',
    'drawer.emptyWorkspace': '工作区为空',
    'drawer.unsaved': '未保存',
    'drawer.loops': '循环任务 (TCHELVIS)',
    'drawer.noLoops': '暂无循环任务记录。',
    'drawer.lenses': '视图 (.hub/views/)',
    'drawer.noLenses': '暂无已发布视图。',
    'drawer.terminal': '终端',
    'drawer.collapseTerminal': '收起终端 (Ctrl+J)',
    'drawer.resizeLeft': '拖动调整左侧面板宽度',
    'drawer.resizeRight': '拖动调整聊天面板宽度',
    'drawer.resizeBottom': '拖动调整终端高度',

    // Chat Panel
    'chat.title': 'Chat',
    'chat.subtitle': '项目助手',
    'chat.dirtyFiles': '上下文中有 {count} 个未保存文件',
    'chat.quotaExceeded': '.hub/captures/ 已超出 200 MiB 配额，请考虑清理旧截图。',
    'chat.empty':
      '在 Chat 中讨论 GDD、世界观设定或派发代码循环。按 Ctrl+V 可粘贴一次性截图附件。',
    'chat.roleUser': '你',
    'chat.roleAssistant': 'Chat',
    'chat.roleSystem': '系统',
    'chat.offlineMode': '离线',
    'chat.removeAttachment': '移除附件',
    'chat.placeholder': '发送消息到 Chat... (Ctrl+V 粘贴图片)',
    'chat.addImage': '+ 图片',
    'chat.send': '发送',
    'chat.sending': '发送中...',
    'chat.sendError': '发送消息到 Chat 失败: {error}',

    // Settings Modal
    'settings.title': '设置',
    'settings.close': '关闭 (Esc)',
    'settings.languageTitle': '语言',
    'settings.languageDesc': '选择应用界面的显示语言。',
    'settings.languageLabel': '界面语言',
    'settings.updatesTitle': '更新 (CI/CD 与 GitHub)',
    'settings.updatesDesc': '选择更新通道，检查 GitHub 上的新构建并更新应用。',
    'settings.channelLabel': '通道:',
    'settings.channelStable': 'Stable (稳定版)',
    'settings.channelNightly': 'Nightly (前沿版)',
    'settings.channelStableDesc': '经过完整验证的稳定版本，更新频率较低但更稳妥。',
    'settings.channelNightlyDesc': '来自最新开发的持续前沿构建 (Bleeding Edge)。',
    'settings.sourceRelease': 'CI/CD 发布',
    'settings.sourceGit': 'Git 分支',
    'settings.checkUpdates': '检查更新',
    'settings.checking': '正在检查...',
    'settings.applyUpdate': '立即更新',
    'settings.updating': '正在更新...',
    'settings.branch': '分支:',
    'settings.local': '本地:',
    'settings.remote': '远程:',
    'settings.repo': '仓库:',
    'settings.updatesAvailable': '发现 {count} 个可用更新：',
    'settings.upToDate': '当前已是最新版本。',
    'settings.viewLog': '查看更新日志',

    // Media Viewer
    'media.loading': '正在加载文件...',
    'media.imageMode': '图片',
    'media.modelMode': '3D 模型',
    'media.zoomOut': '缩小',
    'media.zoomIn': '放大',
    'media.fit': '适应视图',
    'media.checkerboard': '棋盘背景',
    'media.resetCamera': '重置视角',
    'media.grid': '网格',
    'media.wireframe': '线框',
    'media.autoRotate': '自动旋转',
    'media.stats': '{meshes} 个网格 · {triangles} 个三角面',
    'media.webglUnsupported': '无法初始化 WebGL 上下文以渲染 3D 模型。',
    'media.unsupportedFormat': '不支持的预览格式: {ext}',
    'media.dragHint': '左键拖动旋转 · 滚轮缩放 · 右键拖动平移',

    // Preview Lightbox
    'preview.ariaLabel': '游戏预览',
    'preview.openExternal': '在外部浏览器中打开',
    'preview.captureFrame': '捕获画面 + 日志',
    'preview.stop': '停止预览',
    'preview.close': '关闭',
    'preview.activeMode': '预览正在以 {mode} 模式运行。',
    'preview.waitingUrl': '等待服务器 URL...',

    // Markdown / Loops / Lens
    'md.loading': '正在加载 {path}...',
    'md.save': '保存 (Ctrl+S)',
    'md.saving': '保存中...',
    'md.saved': '已保存',
    'md.editor': '编辑',
    'md.split': '分栏',
    'md.preview': '预览',
    'md.externalConflict': '该文件已在磁盘上被外部修改，同时您有未保存的本地更改。',
    'md.reloadFromDisk': '从磁盘重新加载',
    'md.keepBuffer': '保留本地内容',
    'md.collisionTitle': '多个笔记匹配 [[{target}]]：',
    'md.cancel': '取消',
    'loops.empty': '在 .loops/runs/ 中未找到 Tchelvis 运行记录。',
    'lens.loading': '正在加载视图 {id}...',
    'lens.reload': '重新加载',
  },
} as const;

export type TranslationKey = keyof (typeof translations)['pt-BR'];

export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>
): string {
  const dict = translations[locale] ?? translations.en;
  let template: string = dict[key] ?? translations.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }
  return template;
}
