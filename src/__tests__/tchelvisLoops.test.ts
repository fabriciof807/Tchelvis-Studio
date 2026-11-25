import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ipc, type LoopRunState } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { LoopsPanel } from '../panels/LoopsPanel';

describe('Tchelvis loop IPC mocks, /loop chat command & LoopsPanel', () => {
  beforeEach(() => {
    cleanup();
    useWorkspaceStore.setState({
      workspace: {
        root_path: '/tmp/mock-game',
        name: 'mock-game',
        is_uninitialized: false,
        project_config: {
          schema_version: 1,
          engine: 'web',
          game_dir: 'game',
          default_branch: 'main',
        },
        orphan_worktrees: [],
        offline_completed_runs: [],
      },
      loopRuns: [],
      chatMessages: [],
      oneShotAttachments: [],
      pendingPanelRequest: null,
      previewStatus: null,
      isSendingChat: false,
      locale: 'pt-BR',
    });
  });

  it('provides browser/Vitest mock implementations for listLoopWorkflows, checkLoop, dispatchLoop and stopLoop', async () => {
    const workflows = await ipc.listLoopWorkflows();
    expect(workflows.some((w) => w.name === 'fast-worker-reviewer')).toBe(true);

    const check = await ipc.checkLoop('fast-worker-reviewer', [
      'implement=pi:opencode-go/deepseek-v4.1-flash',
    ]);
    expect(check.ok).toBe(true);
    expect(check.workflow).toBe('fast-worker-reviewer');

    const dispatched = await ipc.dispatchLoop(
      'fast-worker-reviewer',
      'Adicionar dash',
      'Implementar dash com cooldown',
      {
        use_overrides: [
          'implement=pi:opencode-go/deepseek-v4.1-flash',
          'review=pi:opencode-go/hy4-flash-free',
        ],
        max_cycles: 2,
        from_head: true,
      }
    );
    expect(dispatched.status).toBe('running');
    expect(dispatched.max_cycles).toBe(2);

    const runs = await ipc.listLoopRuns();
    expect(runs.some((r) => r.run_id === dispatched.run_id)).toBe(true);

    await ipc.stopLoop(dispatched.run_id);
    const afterStop = await ipc.listLoopRuns();
    const stopped = afterStop.find((r) => r.run_id === dispatched.run_id);
    expect(stopped?.status).toBe('cancelled');
  });

  it('dispatches fast-worker-reviewer via /loop slash command in workspaceStore', async () => {
    const mockRun: LoopRunState = {
      run_id: '20261125-030000-abcd',
      workflow: 'fast-worker-reviewer',
      title: 'Corrigir colisão do escudo',
      status: 'running',
      raw_status: 'RUNNING',
      branch: 'loop/fast-worker-reviewer-20261125-030000-abcd',
      worktree_path: null,
      current_stage: 'implement',
      current_cycle: 1,
      max_cycles: 3,
      created_at: '2026-11-25T03:00:00Z',
      updated_at: '2026-11-25T03:00:00Z',
      stages: [],
      files: [],
    };

    const dispatchSpy = vi.spyOn(ipc, 'dispatchLoop').mockResolvedValueOnce(mockRun);
    const listSpy = vi.spyOn(ipc, 'listLoopRuns').mockResolvedValueOnce([mockRun]);

    await useWorkspaceStore.getState().sendChatMessage('/loop Corrigir colisão do escudo');

    expect(dispatchSpy).toHaveBeenCalledWith(
      'fast-worker-reviewer',
      'Corrigir colisão do escudo',
      'Corrigir colisão do escudo',
      {
        from_head: true,
        max_cycles: 3,
        use_overrides: [
          'implement=pi:opencode-go/deepseek-v4.1-flash',
          'review=pi:opencode-go/hy4-flash-free',
        ],
      }
    );
    expect(useWorkspaceStore.getState().loopRuns).toEqual([mockRun]);
    expect(useWorkspaceStore.getState().pendingPanelRequest?.panelType).toBe('loops');
    expect(useWorkspaceStore.getState().pendingPanelRequest?.params).toEqual({
      runId: mockRun.run_id,
    });
    expect(useWorkspaceStore.getState().chatMessages.some((m) => m.text.includes(mockRun.run_id))).toBe(true);

    dispatchSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('renders LoopsPanel launcher, active stop button, stage details, and branch-only integrate action', async () => {
    const runningRun: LoopRunState = {
      run_id: '20261125-031000-live',
      workflow: 'fast-worker-reviewer',
      title: 'Loop em execução',
      status: 'running',
      raw_status: 'RUNNING',
      branch: 'loop/fast-worker-reviewer-20261125-031000-live',
      worktree_path: null,
      current_stage: 'implement',
      current_cycle: 1,
      max_cycles: 2,
      created_at: '2026-11-25T03:10:00Z',
      updated_at: '2026-11-25T03:10:05Z',
      stages: [
        {
          name: 'implement',
          role: 'worker',
          model: 'pi:opencode-go/deepseek-v4.1-flash',
          cycle: 1,
          status: 'completed',
          duration_ms: 4200,
          verdict: 'OK',
        },
      ],
      files: ['README.md'],
    };

    useWorkspaceStore.setState({ loopRuns: [runningRun] });

    const listWfSpy = vi.spyOn(ipc, 'listLoopWorkflows').mockResolvedValueOnce([
      { name: 'fast-worker-reviewer', source: 'preset', description: 'Rápido' },
    ]);
    const checkSpy = vi.spyOn(ipc, 'checkLoop').mockResolvedValueOnce({
      ok: true,
      tchelvis_available: true,
      auto_approve_enabled: true,
      workflow: 'fast-worker-reviewer',
      output: 'Workflow válido',
    });
    const stopSpy = vi.spyOn(ipc, 'stopLoop').mockResolvedValueOnce();
    const listRunsSpy = vi.spyOn(ipc, 'listLoopRuns').mockResolvedValue([runningRun]);

    render(
      React.createElement(LoopsPanel, {
        params: { runId: runningRun.run_id },
        api: {} as never,
        containerApi: {} as never,
      })
    );

    expect(screen.getByText('Loop em execução')).toBeTruthy();
    expect(screen.getByText('Ciclo 1/2')).toBeTruthy();
    expect(screen.getByText('loop/fast-worker-reviewer-20261125-031000-live')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.getByText('pi:opencode-go/deepseek-v4.1-flash')).toBeTruthy();

    // Stop button should trigger ipc.stopLoop
    const stopBtn = screen.getByRole('button', { name: 'Parar Loop' });
    fireEvent.click(stopBtn);
    await waitFor(() => {
      expect(stopSpy).toHaveBeenCalledWith(runningRun.run_id);
    });

    // Open launcher and run checkLoop
    const newLoopBtn = screen.getByRole('button', { name: '+ Novo Loop' });
    fireEvent.click(newLoopBtn);
    const verifyBtn = screen.getByRole('button', { name: 'Verificar' });
    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(checkSpy).toHaveBeenCalledWith('fast-worker-reviewer', [
        'implement=pi:opencode-go/deepseek-v4.1-flash',
        'review=pi:opencode-go/hy4-flash-free',
      ]);
      expect(screen.getByText('Workflow válido')).toBeTruthy();
    });

    listWfSpy.mockRestore();
    checkSpy.mockRestore();
    stopSpy.mockRestore();
    listRunsSpy.mockRestore();
  });

  it('enables Approve & Integrate for completed branch-only runs without worktree_path', async () => {
    const completedBranchRun: LoopRunState = {
      run_id: '20261125-023057-eec8',
      workflow: 'fast-worker-reviewer',
      title: 'Branch-only completed run',
      status: 'completed',
      raw_status: 'PASS',
      branch: 'loop/fast-worker-reviewer-20261125-023057-eec8',
      worktree_path: null,
      current_stage: 'review',
      current_cycle: 1,
      max_cycles: 2,
      created_at: '2026-11-25T02:30:57Z',
      updated_at: '2026-11-25T02:31:32Z',
      stages: [],
      files: ['README.md'],
    };

    useWorkspaceStore.setState({ loopRuns: [completedBranchRun] });
    const checkMergeSpy = vi.spyOn(ipc, 'gitCheckWorktreeMerge').mockResolvedValueOnce({
      can_merge: true,
      can_merge_cleanly: true,
      dirty_files: [],
      colliding_files: [],
      conflicting_dirty_files: [],
      requires_stash: false,
      worktree_path: null,
      branch: completedBranchRun.branch!,
    });
    const mergeSpy = vi.spyOn(ipc, 'gitMergeWorktree').mockResolvedValueOnce({
      merged: true,
      stashed: false,
      message: 'Merged branch',
    });
    const listRunsSpy = vi.spyOn(ipc, 'listLoopRuns').mockResolvedValue([completedBranchRun]);

    render(
      React.createElement(LoopsPanel, {
        params: { runId: completedBranchRun.run_id },
        api: {} as never,
        containerApi: {} as never,
      })
    );

    const integrateBtn = screen.getByRole('button', { name: 'Aprovar & Integrar' }) as HTMLButtonElement;
    expect(integrateBtn.disabled).toBe(false);
    fireEvent.click(integrateBtn);

    await waitFor(() => {
      expect(checkMergeSpy).toHaveBeenCalledWith(completedBranchRun.run_id);
      expect(mergeSpy).toHaveBeenCalledWith(completedBranchRun.run_id, false);
    });

    checkMergeSpy.mockRestore();
    mergeSpy.mockRestore();
    listRunsSpy.mockRestore();
  });
});
