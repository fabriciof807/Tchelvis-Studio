import React, { memo, useRef, useState } from 'react';
import { ipc } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useI18n } from '../i18n/useI18n';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  ImageIcon,
  PaperclipIcon,
} from '../components/Icons';
import { PiSetupWizard } from '../components/PiSetupWizard';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler imagem'));
    reader.readAsDataURL(file);
  });
}

export const ChatPanel: React.FC = memo(() => {
  const { t } = useI18n();
  const chatMessages = useWorkspaceStore((s) => s.chatMessages);
  const subagentStatuses = useWorkspaceStore((s) => s.subagentStatuses);
  const compactionNotice = useWorkspaceStore((s) => s.compactionNotice);
  const dirtyFiles = useWorkspaceStore((s) => s.dirtyFiles);
  const oneShotAttachments = useWorkspaceStore((s) => s.oneShotAttachments);
  const isSendingChat = useWorkspaceStore((s) => s.isSendingChat);
  const capturesQuotaExceeded = useWorkspaceStore((s) => s.capturesQuotaExceeded);
  const piSetupStatus = useWorkspaceStore((s) => s.piSetupStatus);
  const piSetupOpen = useWorkspaceStore((s) => s.piSetupOpen);

  const sendChatMessage = useWorkspaceStore((s) => s.sendChatMessage);
  const addOneShotAttachment = useWorkspaceStore((s) => s.addOneShotAttachment);
  const removeOneShotAttachment = useWorkspaceStore((s) => s.removeOneShotAttachment);
  const setCaptureQuotaStatus = useWorkspaceStore((s) => s.setCaptureQuotaStatus);
  const setPiSetupOpen = useWorkspaceStore((s) => s.setPiSetupOpen);

  const [draft, setDraft] = useState('');
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleAttachImageFile = async (file: File, type: 'clipboard_image' | 'file_image') => {
    setUploadError(null);
    try {
      const b64 = await fileToBase64(file);
      const ext = file.name.split('.').pop() || 'png';
      const filename = `capture-${Date.now()}.${ext}`;
      const saved = await ipc.saveCapture(filename, b64);
      setCaptureQuotaStatus(saved.total_captures_bytes, saved.quota_exceeded);
      addOneShotAttachment({
        type,
        image_path: saved.rel_path,
        user_note: file.name || 'Captura colada',
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void handleAttachImageFile(file, 'clipboard_image');
          return;
        }
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleAttachImageFile(file, 'file_image');
    }
    e.target.value = '';
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!draft.trim() && oneShotAttachments.length === 0) || isSendingChat) return;
    const text = draft;
    setDraft('');
    void sendChatMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const subagentEntries = Object.entries(subagentStatuses);
  const providerReady = piSetupStatus?.provider_ready === true;
  const pillLabel = providerReady
    ? `${piSetupStatus?.active_provider ?? 'pi'}${
        piSetupStatus?.active_model ? ` · ${piSetupStatus.active_model}` : ''
      }`
    : piSetupStatus?.first_run_completed
      ? t('piSetup.pillOffline')
      : t('piSetup.pillConnect');

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-title-row">
          <span className="chat-title">{t('chat.title')}</span>
          <span className="chat-subtitle">{t('chat.subtitle')}</span>
          <button
            type="button"
            className={`pi-provider-pill ${providerReady ? 'ready' : 'warning'}`}
            onClick={() => setPiSetupOpen(!piSetupOpen)}
            title={t('piSetup.settingsConfigureBtn')}
          >
            <span className={`pi-status-dot ${providerReady ? 'ready' : 'warning'}`} />
            <span className="pi-pill-text">{pillLabel}</span>
          </button>
        </div>
        {dirtyFiles.length > 0 && (
          <div className="dirty-indicator" title={dirtyFiles.join('\n')}>
            {t('chat.dirtyFiles', { count: dirtyFiles.length })}
          </div>
        )}
      </div>

      {piSetupOpen && <PiSetupWizard />}

      {subagentEntries.length > 0 && (
        <div className="subagent-bar">
          {subagentEntries.map(([name, info]) => (
            <span key={name} className={`subagent-badge status-${info.status}`} title={info.detail}>
              {name}: {info.status}
            </span>
          ))}
        </div>
      )}

      {compactionNotice && <div className="banner-info">{compactionNotice}</div>}
      {capturesQuotaExceeded && (
        <div className="banner-warning">
          {t('chat.quotaExceeded')}
        </div>
      )}
      {uploadError && <div className="banner-error">{uploadError}</div>}

      <div className="chat-messages">
        {chatMessages.length === 0 && (
          <div className="chat-empty">{t('chat.empty')}</div>
        )}
        {chatMessages.map((msg) => (
          <div key={msg.id} className={`chat-msg role-${msg.role}`}>
            <div className="chat-msg-meta">
              <span className="chat-msg-author">
                {msg.role === 'user'
                  ? t('chat.roleUser')
                  : msg.role === 'assistant'
                    ? t('chat.roleAssistant')
                    : t('chat.roleSystem')}
              </span>
              {msg.mode === 'offline_fallback' && (
                <span className="mode-pill">{t('chat.offlineMode')}</span>
              )}
            </div>
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="msg-attachments">
                {msg.attachments.map((att, i) => (
                  <span key={`${att.image_path}-${i}`} className="attachment-chip-sent">
                    <PaperclipIcon size={12} />
                    <span>{att.image_path}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="chat-msg-text">{msg.text}</div>
            {msg.tool_calls && msg.tool_calls.length > 0 && (
              <div className="tool-calls-list">
                {msg.tool_calls.map((tc) => {
                  const isOpen = Boolean(expandedTools[tc.id]);
                  return (
                    <div key={tc.id} className="tool-call-block">
                      <button
                        type="button"
                        className="tool-call-toggle"
                        onClick={() => toggleTool(tc.id)}
                      >
                        <span className="inline-icon-text">
                          {isOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                          <span>{tc.name}</span>
                        </span>
                        <span className={`tool-status status-${tc.status}`}>{tc.status}</span>
                      </button>
                      {isOpen && (
                        <div className="tool-call-body">
                          <pre>{tc.arguments_json}</pre>
                          {tc.result_json && <pre className="tool-result">{tc.result_json}</pre>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <form className="chat-composer" onSubmit={handleSubmit}>
        {oneShotAttachments.length > 0 && (
          <div className="oneshot-chips">
            {oneShotAttachments.map((att, idx) => (
              <span key={`${att.image_path}-${idx}`} className="oneshot-chip">
                <span className="inline-icon-text" title={att.user_note ?? att.image_path}>
                  <ImageIcon size={12} />
                  <span>{att.image_path.split('/').pop()}</span>
                </span>
                <button
                  type="button"
                  className="chip-remove"
                  onClick={() => removeOneShotAttachment(idx)}
                  aria-label={t('chat.removeAttachment')}
                >
                  <CloseIcon size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          className="chat-input"
          rows={3}
          placeholder={t('chat.placeholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-composer-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden-file-input"
            onChange={handleFileChange}
          />
          <button
            type="button"
            className="btn-ghost-sm"
            onClick={() => fileInputRef.current?.click()}
          >
            {t('chat.addImage')}
          </button>
          <button
            type="submit"
            className="btn-primary-sm"
            disabled={isSendingChat || (!draft.trim() && oneShotAttachments.length === 0)}
          >
            {isSendingChat ? t('chat.sending') : t('chat.send')}
          </button>
        </div>
      </form>
    </div>
  );
});

ChatPanel.displayName = 'ChatPanel';
