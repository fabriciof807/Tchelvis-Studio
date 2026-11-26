import { describe, expect, it } from 'vitest';
import { PREVIEW_STATUS_KEYS, mockPreviewStatus } from '../types/ipc';
import type { PreviewStatus } from '../types/ipc';

// Mirrors the key list pinned by `preview_status_serializes_exact_keys` in src-tauri/src/preview.rs.
const WIRE_KEYS = [
  'can_capture',
  'compositor_available',
  'degraded_reason',
  'engine',
  'logs',
  'mode',
  'pid',
  'running',
  'url',
  'worktree_path',
];

// Fails `tsc` if the TS type gains, loses or renames a key the Rust side sends.
const _previewStatusKeys: Record<keyof PreviewStatus, true> = {
  running: true,
  mode: true,
  engine: true,
  url: true,
  pid: true,
  worktree_path: true,
  compositor_available: true,
  can_capture: true,
  degraded_reason: true,
  logs: true,
};

describe('preview contract', () => {
  it('mock status has exactly the wire keys', () => {
    expect([...PREVIEW_STATUS_KEYS].sort()).toEqual(WIRE_KEYS);
    expect(Object.keys(_previewStatusKeys).sort()).toEqual(WIRE_KEYS);
    expect(Object.keys(mockPreviewStatus({})).sort()).toEqual(WIRE_KEYS);
  });

  it('mock status overrides only the requested fields', () => {
    const status = mockPreviewStatus({
      running: true,
      mode: 'staging',
      engine: 'godot',
      pid: 4242,
      logs: ['boot'],
    });
    expect(status).toMatchObject({
      running: true,
      mode: 'staging',
      engine: 'godot',
      pid: 4242,
      logs: ['boot'],
    });
    expect(Object.keys(status).sort()).toEqual(WIRE_KEYS);
  });
});
