import React, { useEffect, useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  ipc,
  type GitMergeCheckResult,
  type LoopCheckResult,
  type LoopRunState,
  type LoopWorkflowInfo,
} from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useI18n } from '../i18n/useI18n';
import { injectLensCsp } from './CustomLensPanel';

export interface LoopsPanelParams {
  runId?: string;
}

const DEFAULT_WORKFLOW = 'fast-worker-reviewer';
const DEFAULT_IMPLEMENT_MODEL = 'pi:opencode-go/deepseek-v4.1-flash';
const DEFAULT_REVIEW_MODEL = 'pi:opencode-go/hy4-flash-free';

function formatDurationMs(ms?: number | null): string | null {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const LoopsPanel: React.FC<IDockviewPanelProps<LoopsPanelParams>> = ({ params }) => {
  const { t } = useI18n();
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

  // Launcher form state
  const [launcherOpen, setLauncherOpen] = useState<boolean>(() => loopRuns.length === 0);
  const [workflows, setWorkflows] = useState<LoopWorkflowInfo[]>([]);
  const [workflow, setWorkflow] = useState<string>(DEFAULT_WORKFLOW);
  const [title, setTitle] = useState<string>('');
  const [specMarkdown, setSpecMarkdown] = useState<string>('');
  const [implementModel, setImplementModel] = useState<string>(DEFAULT_IMPLEMENT_MODEL);
  const [reviewModel, setReviewModel] = useState<string>(DEFAULT_REVIEW_MODEL);
  const [maxCycles, setMaxCycles] = useState<number>(3);
  const [fromHead, setFromHead] = useState<boolean>(true);
  const [checkResult, setCheckResult] = useState<LoopCheckResult | null>(null);
  const [checking, setChecking] = useState<boolean>(false);
  const [dispatching, setDispatching] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    void ipc
      .listLoopWorkflows()
      .then((list) => {
        if (!mounted || list.length === 0) return;
        setWorkflows(list);
        if (!list.some((w) => w.name === workflow)) {
          setWorkflow(list[0].name);
        }
      })
      .catch(() => {
        // Keep default fallback option
      });
    return () => {
      mounted = false;
    };
  }, []);

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

  const buildUseOverrides = (): string[] => {
    const overrides: string[] = [];
    const impl = implementModel.trim();
    const rev = reviewModel.trim();
    if (impl) overrides.push(`implement=${impl}`);
    if (rev) overrides.push(`review=${rev}`);
    return overrides;
  };

  const handleCheckLoop = async () => {
    setChecking(true);
    setActionError(null);
    setCheckResult(null);
    try {
      const res = await ipc.checkLoop(workflow, buildUseOverrides());
      setCheckResult(res);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const handleDispatchLoop = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanSpec = specMarkdown.trim();
    const cleanTitle = title.trim() || cleanSpec.split('\n')[0]?.slice(0, 60) || workflow;
    if (!cleanSpec) return;

    setDispatching(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const run = await ipc.dispatchLoop(workflow, cleanTitle, cleanSpec, {
        use_overrides: buildUseOverrides(),
        max_cycles: Math.max(1, Math.min(20, Number(maxCycles) || 3)),
        from_head: fromHead,
      });
      await refreshLoopRuns();
      setSelectedRunId(run.run_id);
      setTitle('');
      setSpecMarkdown('');
      setLauncherOpen(false);
      setActionMessage(`Loop iniciado: ${run.run_id} (${run.status}).`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  };

  const handleStopLoop = async () => {
    if (!activeRun) return;
    setBusy(true);
    setActionError(null);
    try {
      await ipc.stopLoop(activeRun.run_id);
      await refreshLoopRuns();
      setActionMessage(`Cancelamento solicitado para ${activeRun.run_id}.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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

  const canIntegrate =
    Boolean(activeRun) &&
    activeRun?.status === 'completed' &&
    Boolean(activeRun?.branch || activeRun?.worktree_path);

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
            {loopRuns.length === 0 && <option value="">{t('loops.selectPlaceholder')}</option>}
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
            className={launcherOpen ? 'btn-primary-sm' : 'btn-ghost-sm'}
            onClick={() => setLauncherOpen((v) => !v)}
          >
            + {t('loops.newLoop')}
          </button>
          <button
            type="button"
            className="btn-ghost-sm"
            onClick={() => void refreshLoopRuns()}
          >
            {t('loops.refresh')}
          </button>
          {activeRun && (
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => void handleLoadReport(activeRun.run_id)}
            >
              {t('loops.viewReport')}
            </button>
          )}
        </div>
      </div>

      {actionMessage && <div className="banner-info">{actionMessage}</div>}
      {actionError && <div className="banner-error">{actionError}</div>}

      {mergeCheck && (
        <div className="banner-warning">
          <div>
            <strong>{t('loops.mergeWarning')}</strong>{' '}
            <code>
              {(mergeCheck.colliding_files.length > 0
                ? mergeCheck.colliding_files
                : mergeCheck.dirty_files
              ).join(', ') || 'working tree'}
            </code>
          </div>
          <div className="banner-actions">
            <button
              type="button"
              className="btn-warn-sm"
              disabled={busy}
              onClick={() => void handleConfirmStashMerge()}
            >
              {t('loops.stashAndMerge')}
            </button>
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setMergeCheck(null)}
            >
              {t('loops.abort')}
            </button>
          </div>
        </div>
      )}

      <div className="loops-content">
        {launcherOpen && (
          <form className="loop-launcher-card" onSubmit={(e) => void handleDispatchLoop(e)}>
            <div className="loop-launcher-header">
              <strong>+ {t('loops.newLoop')}</strong>
            </div>

            <div className="loop-launcher-grid">
              <label className="loop-field">
                <span>{t('loops.workflow')}</span>
                <select
                  className="select-sm"
                  value={workflow}
                  onChange={(e) => setWorkflow(e.target.value)}
                >
                  {(workflows.length > 0
                    ? workflows
                    : [{ name: DEFAULT_WORKFLOW, source: 'preset', description: '' }]
                  ).map((wf) => (
                    <option key={wf.name} value={wf.name}>
                      {wf.name} [{wf.source}]
                    </option>
                  ))}
                </select>
              </label>

              <label className="loop-field">
                <span>{t('loops.maxCycles')}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="loop-input-sm"
                  value={maxCycles}
                  onChange={(e) => setMaxCycles(Number(e.target.value) || 1)}
                />
              </label>
            </div>

            <label className="loop-field">
              <span>{t('loops.titleLabel')}</span>
              <input
                type="text"
                className="loop-input-sm"
                placeholder={t('loops.titlePlaceholder')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>

            <label className="loop-field">
              <span>{t('loops.promptLabel')}</span>
              <textarea
                className="loop-textarea"
                rows={4}
                placeholder={t('loops.promptPlaceholder')}
                value={specMarkdown}
                onChange={(e) => setSpecMarkdown(e.target.value)}
              />
            </label>

            <div className="loop-launcher-grid">
              <label className="loop-field">
                <span>{t('loops.implementModel')}</span>
                <input
                  type="text"
                  className="loop-input-sm"
                  value={implementModel}
                  onChange={(e) => setImplementModel(e.target.value)}
                />
              </label>
              <label className="loop-field">
                <span>{t('loops.reviewModel')}</span>
                <input
                  type="text"
                  className="loop-input-sm"
                  value={reviewModel}
                  onChange={(e) => setReviewModel(e.target.value)}
                />
              </label>
            </div>

            <div className="loop-launcher-footer">
              <label className="loop-checkbox">
                <input
                  type="checkbox"
                  checked={fromHead}
                  onChange={(e) => setFromHead(e.target.checked)}
                />
                <span>{t('loops.fromHead')}</span>
              </label>

              <div className="loop-launcher-actions">
                <button
                  type="button"
                  className="btn-ghost-sm"
                  disabled={checking || dispatching}
                  onClick={() => void handleCheckLoop()}
                >
                  {checking ? t('loops.checking') : t('loops.check')}
                </button>
                <button
                  type="submit"
                  className="btn-primary-sm"
                  disabled={dispatching || !specMarkdown.trim()}
                >
                  {dispatching ? t('loops.starting') : t('loops.start')}
                </button>
              </div>
            </div>

            {checkResult && (
              <div className={`loop-check-box ${checkResult.ok ? 'check-ok' : 'check-fail'}`}>
                <div className="loop-check-header">
                  <strong>
                    {checkResult.ok ? 'OK' : 'Erro'} · {checkResult.workflow}
                  </strong>
                  {checkResult.auto_approve_enabled !== null &&
                    checkResult.auto_approve_enabled !== undefined && (
                      <span>
                        auto_approve_in_sandbox={String(checkResult.auto_approve_enabled)}
                      </span>
                    )}
                </div>
                <pre className="loop-check-output">{checkResult.output}</pre>
              </div>
            )}
          </form>
        )}

        {!activeRun ? (
          <div className="panel-empty">{t('loops.noRunsHint')}</div>
        ) : (
          <>
            <div className="loop-header-card">
              <div className="loop-title-row">
                <h3>{activeRun.title}</h3>
                <div className="loop-badges">
                  {activeRun.current_cycle != null && (
                    <span className="loop-cycle-pill">
                      {t('loops.cycle')} {activeRun.current_cycle}
                      {activeRun.max_cycles ? `/${activeRun.max_cycles}` : ''}
                    </span>
                  )}
                  <span className={`loop-status-pill status-${activeRun.status}`}>
                    {activeRun.status}
                  </span>
                </div>
              </div>
              <div className="loop-meta">
                <span>Workflow: {activeRun.workflow}</span>
                {activeRun.branch && <span className="loop-branch-badge">{activeRun.branch}</span>}
                {activeRun.worktree_path && <span>Worktree: {activeRun.worktree_path}</span>}
              </div>
              {activeRun.summary && <p className="loop-summary">{activeRun.summary}</p>}
              {activeRun.error && <p className="loop-error-text">{activeRun.error}</p>}
              {activeRun.files && activeRun.files.length > 0 && (
                <div className="loop-files-list">
                  <span className="loop-files-label">{t('loops.changedFiles')}:</span>
                  {activeRun.files.map((f) => (
                    <code key={f} className="loop-file-chip">
                      {f}
                    </code>
                  ))}
                </div>
              )}
            </div>

            <div className="staging-bar">
              {activeRun.status === 'running' && (
                <button
                  type="button"
                  className="btn-warn-sm"
                  disabled={busy}
                  onClick={() => void handleStopLoop()}
                >
                  {t('loops.stop')}
                </button>
              )}
              {!isStagingActiveForRun && activeRun.worktree_path && (
                <button
                  type="button"
                  className="btn-primary-sm"
                  disabled={busy}
                  onClick={() => void handleStagingStart()}
                >
                  {t('loops.stagingStart')}
                </button>
              )}
              <button
                type="button"
                className="btn-ghost-sm"
                disabled={busy || !isStagingActiveForRun}
                onClick={() => void handleStagingStop()}
              >
                {t('loops.stagingStop')}
              </button>
              <button
                type="button"
                className="btn-ghost-sm"
                disabled={busy || !activeRun.worktree_path}
                onClick={() => void handleStagingRestart()}
              >
                {t('loops.stagingRestart')}
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
                {t('loops.captureFrame')}
              </button>
              <button
                type="button"
                className="btn-primary-sm"
                disabled={busy || !canIntegrate}
                onClick={() => void handleApproveAndIntegrate()}
              >
                {t('loops.approveAndIntegrate')}
              </button>
            </div>

            <div className="stages-list">
              {activeRun.stages.map((stage, idx) => {
                const dur = formatDurationMs(stage.duration_ms);
                return (
                  <div
                    key={`${stage.name}-${stage.cycle ?? idx}-${idx}`}
                    className={`stage-item status-${stage.status}`}
                  >
                    <span className="stage-name">
                      {stage.cycle ? `c${stage.cycle} · ` : ''}
                      {stage.name}
                    </span>
                    {stage.role && <span className="stage-chip">{stage.role}</span>}
                    {stage.model && <code className="stage-model">{stage.model}</code>}
                    <span className="stage-status">{stage.status}</span>
                    {stage.verdict && <span className="stage-verdict">{stage.verdict}</span>}
                    {dur && <span className="stage-duration">{dur}</span>}
                    {stage.summary && <span className="stage-summary">{stage.summary}</span>}
                  </div>
                );
              })}
            </div>

            {reportHtml && (
              <div className="loop-report-box">
                <div className="loop-report-header">
                  <span>{t('loops.viewReport')} (sandboxed)</span>
                  <button
                    type="button"
                    className="btn-ghost-sm"
                    onClick={() => setReportHtml(null)}
                  >
                    {t('loops.closeReport')}
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
          </>
        )}
      </div>
    </div>
  );
};
