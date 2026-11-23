import React, { useEffect, useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { ipc, type GitMergeCheckResult, type LoopRunState } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { injectLensCsp } from './CustomLensPanel';

export interface LoopsPanelParams {
  runId?: string;
}

export const LoopsPanel: React.FC<IDockviewPanelProps<LoopsPanelParams>> = ({ params }) => {
  const loopRuns = useWorkspaceStore((s) => s.loopRuns);
  const previewStatus = useWorkspaceStore((s) => s.previewStatus);
  const refreshLoopRuns = useWorkspaceStore((s) => s.refreshLoopRuns);
  const startPreview = useWorkspaceStore((s) => s.startPreview);
  const stopPreview = useWorkspaceStore((s) => s.stopPreview);
  const capturePreviewFrame = useWorkspaceStore((s) => s.capturePreviewFrame);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(params?.runId ?? null);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [mergeCheck, setMergeCheck] = useState<GitMergeCheckResult | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    if (params?.runId) {
      setSelectedRunId(params.runId);
    } else if (!selectedRunId && loopRuns.length > 0) {
      setSelectedRunId(loopRuns[0].run_id);
    }
  }, [params?.runId, loopRuns, selectedRunId]);

  const activeRun: LoopRunState | undefined = useMemo(
    () => loopRuns.find((r) => r.run_id === selectedRunId) ?? loopRuns[0],
    [loopRuns, selectedRunId]
  );

  const handleLoadReport = async (runId: string) => {
    setActionError(null);
    try {
      const html = await ipc.readLoopReport(runId);
      setReportHtml(injectLensCsp(html));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStagingStart = async () => {
    if (!activeRun?.worktree_path) return;
    setBusy(true);
    setActionError(null);
    try {
      await startPreview('staging', activeRun.worktree_path);
      setActionMessage(`Staging iniciado para ${activeRun.run_id}.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStagingStop = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await stopPreview();
      setActionMessage('Preview de staging encerrado.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStagingRestart = async () => {
    if (!activeRun?.worktree_path) return;
    setBusy(true);
    setActionError(null);
    try {
      await stopPreview();
      await startPreview('staging', activeRun.worktree_path);
      setActionMessage('Preview de staging reiniciado.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCapture = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await capturePreviewFrame();
      setActionMessage('Frame + log anexados como chip one-shot no Chat.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleApproveAndIntegrate = async () => {
    if (!activeRun) return;
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      if (previewStatus?.running) {
        await stopPreview();
      }
      const check = await ipc.gitCheckWorktreeMerge(activeRun.run_id);
      if (!check.can_merge_cleanly || check.requires_stash || check.colliding_files.length > 0) {
        setMergeCheck(check);
        setBusy(false);
        return;
      }
      const res = await ipc.gitMergeWorktree(activeRun.run_id, false);
      setActionMessage(res.message);
      await refreshLoopRuns();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmStashMerge = async () => {
    if (!activeRun) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await ipc.gitMergeWorktree(activeRun.run_id, true);
      setMergeCheck(null);
      setActionMessage(res.message);
      await refreshLoopRuns();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const isStagingActiveForRun =
    Boolean(previewStatus?.running) &&
    previewStatus?.mode === 'staging' &&
    (!activeRun?.worktree_path || previewStatus?.worktree_path === activeRun.worktree_path);

  return (
    <div className="panel-shell">
      <div className="panel-toolbar">
        <div className="panel-toolbar-left">
          <span className="file-badge">Tchelvis-Supervisor</span>
          <select
            className="select-sm"
            value={activeRun?.run_id ?? ''}
            onChange={(e) => {
              setSelectedRunId(e.target.value);
              setReportHtml(null);
              setMergeCheck(null);
            }}
          >
            {loopRuns.length === 0 && <option value="">Nenhum loop encontrado</option>}
            {loopRuns.map((run) => (
              <option key={run.run_id} value={run.run_id}>
                [{run.status}] {run.title} ({run.run_id})
              </option>
            ))}
          </select>
        </div>
        <div className="panel-toolbar-right">
          <button
            type="button"
            className="btn-ghost-sm"
            onClick={() => void refreshLoopRuns()}
          >
            Atualizar
          </button>
          {activeRun && (
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => void handleLoadReport(activeRun.run_id)}
            >
              Ver report.html
            </button>
          )}
        </div>
      </div>

      {actionMessage && <div className="banner-info">{actionMessage}</div>}
      {actionError && <div className="banner-error">{actionError}</div>}

      {mergeCheck && (
        <div className="banner-warning">
          <div>
            <strong>Atenção ao integrar:</strong> arquivos modificados/colidindo na árvore principal:{' '}
            <code>
              {(mergeCheck.colliding_files.length > 0
                ? mergeCheck.colliding_files
                : mergeCheck.dirty_files
              ).join(', ') || 'working tree suja'}
            </code>
          </div>
          <div className="banner-actions">
            <button
              type="button"
              className="btn-warn-sm"
              disabled={busy}
              onClick={() => void handleConfirmStashMerge()}
            >
              Fazer git stash e Integrar
            </button>
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setMergeCheck(null)}
            >
              Abortar
            </button>
          </div>
        </div>
      )}

      {!activeRun ? (
        <div className="panel-empty">
          Nenhuma execução em <code>.loops/runs/*/state.json</code>.
        </div>
      ) : (
        <div className="loops-content">
          <div className="loop-header-card">
            <div className="loop-title-row">
              <h3>{activeRun.title}</h3>
              <span className={`loop-status-pill status-${activeRun.status}`}>
                {activeRun.status}
              </span>
            </div>
            <div className="loop-meta">
              <span>Workflow: {activeRun.workflow}</span>
              {activeRun.branch && <span>Branch: {activeRun.branch}</span>}
              {activeRun.worktree_path && <span>Worktree: {activeRun.worktree_path}</span>}
            </div>
            {activeRun.summary && <p className="loop-summary">{activeRun.summary}</p>}
          </div>

          <div className="staging-bar">
            {!isStagingActiveForRun && activeRun.worktree_path && (
              <button
                type="button"
                className="btn-primary-sm"
                disabled={busy}
                onClick={() => void handleStagingStart()}
              >
                Iniciar Staging
              </button>
            )}
            <button
              type="button"
              className="btn-ghost-sm"
              disabled={busy || !isStagingActiveForRun}
              onClick={() => void handleStagingStop()}
            >
              Parar
            </button>
            <button
              type="button"
              className="btn-ghost-sm"
              disabled={busy || !activeRun.worktree_path}
              onClick={() => void handleStagingRestart()}
            >
              Reiniciar
            </button>
            <button
              type="button"
              className="btn-ghost-sm"
              disabled={busy || !previewStatus?.running || !previewStatus?.can_capture}
              title={
                previewStatus && !previewStatus.can_capture
                  ? previewStatus.degraded_reason ?? 'Captura indisponível sem compositor'
                  : 'Capturar frame da janela + log para o chat'
              }
              onClick={() => void handleCapture()}
            >
              Capturar Frame + Log
            </button>
            <button
              type="button"
              className="btn-primary-sm"
              disabled={busy}
              onClick={() => void handleApproveAndIntegrate()}
            >
              Aprovar &amp; Integrar
            </button>
          </div>

          <div className="stages-list">
            {activeRun.stages.map((stage, idx) => (
              <div key={`${stage.name}-${idx}`} className={`stage-item status-${stage.status}`}>
                <span className="stage-name">{stage.name}</span>
                <span className="stage-status">{stage.status}</span>
                {stage.summary && <span className="stage-summary">{stage.summary}</span>}
              </div>
            ))}
          </div>

          {reportHtml && (
            <div className="loop-report-box">
              <div className="loop-report-header">
                <span>report.html (sandboxed)</span>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={() => setReportHtml(null)}
                >
                  Fechar
                </button>
              </div>
              <iframe
                title={`report-${activeRun.run_id}`}
                sandbox="allow-scripts"
                srcDoc={reportHtml}
                className="lens-iframe"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
