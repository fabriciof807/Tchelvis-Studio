import React, { useEffect, useState } from 'react';
import { ipc } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { MaximizeIcon, MinimizeIcon, PlayIcon, SettingsIcon } from '../components/Icons';

interface PresetsBarProps {
  onApplyPresetLayout: (layoutJson: string) => void;
  onResetDefaultLayout: () => void;
  onOpenSettings: () => void;
}

export const PresetsBar: React.FC<PresetsBarProps> = ({
  onApplyPresetLayout,
  onResetDefaultLayout,
  onOpenSettings,
}) => {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const zenMode = useWorkspaceStore((s) => s.zenMode);
  const previewStatus = useWorkspaceStore((s) => s.previewStatus);
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace);
  const toggleZenMode = useWorkspaceStore((s) => s.toggleZenMode);
  const startPreview = useWorkspaceStore((s) => s.startPreview);
  const setPreviewLightboxOpen = useWorkspaceStore((s) => s.setPreviewLightboxOpen);

  const [presets, setPresets] = useState<string[]>([]);

  useEffect(() => {
    if (!workspace) return;
    void ipc.listPresets().then(setPresets).catch(() => setPresets([]));
  }, [workspace]);

  const handleSelectPreset = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value;
    if (!name) return;
    if (name === '__default__') {
      onResetDefaultLayout();
    } else {
      const json = await ipc.loadPreset(name);
      if (json) onApplyPresetLayout(json);
    }
    e.target.value = '';
  };

  const handlePreviewClick = () => {
    if (previewStatus?.running) {
      setPreviewLightboxOpen(true);
    } else {
      void startPreview('main');
    }
  };

  return (
    <header className="presets-bar">
      <div className="presets-bar-left">
        <span className="brand-mark">GAME DEV HUB</span>
        {workspace && (
          <>
            <span className="workspace-pill" title={workspace.root_path}>
              {workspace.name}
            </span>
            {workspace.project_config && (
              <span className="engine-pill">{workspace.project_config.engine}</span>
            )}
          </>
        )}
      </div>

      <div className="presets-bar-right">
        {presets.length > 0 && (
          <select className="select-sm" defaultValue="" onChange={handleSelectPreset}>
            <option value="" disabled>
              Layout Preset...
            </option>
            <option value="__default__">Padrão</option>
            {presets.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          className={`${zenMode ? 'btn-primary-sm' : 'btn-ghost-sm'} inline-icon-btn`}
          onClick={toggleZenMode}
          title="Alternar Zen Mode"
        >
          {zenMode ? <MinimizeIcon size={13} /> : <MaximizeIcon size={13} />}
          <span>{zenMode ? 'Sair do Zen' : 'Zen Mode'}</span>
        </button>

        <button
          type="button"
          className={`${previewStatus?.running ? 'btn-primary-sm' : 'btn-ghost-sm'} inline-icon-btn`}
          onClick={handlePreviewClick}
          title="Preview Flutuante (F5)"
        >
          <PlayIcon size={13} />
          <span>{previewStatus?.running ? 'Preview Ativo (F5)' : 'Preview (F5)'}</span>
        </button>

        <button
          type="button"
          className="btn-ghost-sm inline-icon-btn"
          onClick={onOpenSettings}
          title="Configurações"
        >
          <SettingsIcon size={13} />
          <span>Configurações</span>
        </button>

        <button type="button" className="btn-ghost-sm" onClick={closeWorkspace}>
          Trocar Projeto
        </button>
      </div>
    </header>
  );
};
