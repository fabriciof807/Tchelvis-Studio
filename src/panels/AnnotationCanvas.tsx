import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useI18n } from '../i18n/useI18n';
import {
  ArrowUpRightIcon,
  CloseIcon,
  ImageIcon,
  PenToolIcon,
  SendIcon,
  SquareIcon,
  TrashIcon,
  TypeIcon,
  UndoIcon,
} from '../components/Icons';

export type AnnotationTool = 'pen' | 'rect' | 'arrow' | 'text';

export interface AnnotationPoint {
  x: number;
  y: number;
}

export type AnnotationOp =
  | {
      kind: 'pen';
      color: string;
      strokeWidth: number;
      points: AnnotationPoint[];
    }
  | {
      kind: 'rect';
      color: string;
      strokeWidth: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      kind: 'arrow';
      color: string;
      strokeWidth: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      kind: 'text';
      color: string;
      strokeWidth: number;
      x: number;
      y: number;
      text: string;
    };

export const ANNOTATION_COLORS = [
  '#f7768e',
  '#e0af68',
  '#9ece6a',
  '#7aa2f7',
  '#bb9af7',
  '#ffffff',
] as const;

export const ANNOTATION_STROKE_WIDTHS = [2, 4, 6, 8] as const;

/** Valid 1x1 transparent PNG Base64 fallback for headless/jsdom environments. */
export const FALLBACK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(122, 162, 247, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(122, 162, 247, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function drawAnnotationOp(ctx: CanvasRenderingContext2D, op: AnnotationOp): void {
  ctx.save();
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (op.kind === 'pen') {
    if (op.points.length === 0) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(op.points[0].x, op.points[0].y);
    if (op.points.length === 1) {
      ctx.lineTo(op.points[0].x + 0.1, op.points[0].y + 0.1);
    } else {
      for (let i = 1; i < op.points.length; i += 1) {
        ctx.lineTo(op.points[i].x, op.points[i].y);
      }
    }
    ctx.stroke();
  } else if (op.kind === 'rect') {
    const x = Math.min(op.x1, op.x2);
    const y = Math.min(op.y1, op.y2);
    const w = Math.abs(op.x2 - op.x1);
    const h = Math.abs(op.y2 - op.y1);
    ctx.fillStyle = hexToRgba(op.color, 0.12);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  } else if (op.kind === 'arrow') {
    const angle = Math.atan2(op.y2 - op.y1, op.x2 - op.x1);
    const headLen = Math.max(12, op.strokeWidth * 3.5);
    ctx.beginPath();
    ctx.moveTo(op.x1, op.y1);
    ctx.lineTo(op.x2, op.y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(op.x2, op.y2);
    ctx.lineTo(
      op.x2 - headLen * Math.cos(angle - Math.PI / 6),
      op.y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      op.x2 - headLen * Math.cos(angle + Math.PI / 6),
      op.y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  } else if (op.kind === 'text') {
    const fontSize = Math.max(13, 11 + op.strokeWidth);
    ctx.font = `600 ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
    const metrics = ctx.measureText(op.text);
    const padX = 8;
    const padY = 5;
    const boxW = metrics.width + padX * 2;
    const boxH = fontSize + padY * 2;
    const boxX = op.x;
    const boxY = op.y - boxH / 2;

    ctx.fillStyle = 'rgba(15, 18, 25, 0.88)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    } else {
      ctx.rect(boxX, boxY, boxW, boxH);
    }
    ctx.fill();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = op.color;
    ctx.stroke();

    ctx.fillStyle = '#f1f5f9';
    ctx.textBaseline = 'middle';
    ctx.fillText(op.text, boxX + padX, op.y);
  }

  ctx.restore();
}

export function renderAnnotationScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  baseImage: HTMLImageElement | null,
  sourceUrl: string,
  operations: AnnotationOp[],
  draftOp: AnnotationOp | null
): void {
  ctx.save();
  ctx.clearRect(0, 0, width, height);

  // Base dark slate background
  ctx.fillStyle = '#13161f';
  ctx.fillRect(0, 0, width, height);

  if (baseImage && baseImage.complete && baseImage.naturalWidth > 0) {
    const scale = Math.min(width / baseImage.naturalWidth, height / baseImage.naturalHeight);
    const drawW = baseImage.naturalWidth * scale;
    const drawH = baseImage.naturalHeight * scale;
    const offsetX = (width - drawW) / 2;
    const offsetY = (height - drawH) / 2;
    ctx.drawImage(baseImage, offsetX, offsetY, drawW, drawH);
  } else {
    // Technical 24px grid fallback when grim snapshot is unavailable
    ctx.strokeStyle = 'rgba(122, 162, 247, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }

    // Subtle frozen URL watermark header
    ctx.fillStyle = 'rgba(226, 232, 240, 0.45)';
    ctx.font = '500 12px Inter, system-ui, sans-serif';
    ctx.fillText(`Frozen Reference: ${sourceUrl}`, 16, 24);
  }

  for (const op of operations) {
    drawAnnotationOp(ctx, op);
  }
  if (draftOp) {
    drawAnnotationOp(ctx, draftOp);
  }
  ctx.restore();
}

export function extractPngBase64FromCanvas(canvas: HTMLCanvasElement | null): string {
  if (!canvas) return FALLBACK_PNG_BASE64;
  try {
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
      const payload = dataUrl.slice('data:image/png;base64,'.length);
      if (payload.length > 0) return payload;
    }
  } catch {
    // Fallback for jsdom / tainted canvas
  }
  return FALLBACK_PNG_BASE64;
}

export interface SendAnnotationParams {
  canvas: HTMLCanvasElement | null;
  sourceUrl: string;
  userNote: string;
  defaultNotePrefix: string;
  onSentToChat: () => void;
}

export async function sendAnnotatedCaptureToChat({
  canvas,
  sourceUrl,
  userNote,
  defaultNotePrefix,
  onSentToChat,
}: SendAnnotationParams): Promise<string> {
  const base64Payload = extractPngBase64FromCanvas(canvas);
  const filename = `annotated-${Date.now()}.png`;
  const saved = await ipc.saveCapture(filename, base64Payload);

  const store = useWorkspaceStore.getState();
  store.setCaptureQuotaStatus(saved.total_captures_bytes, saved.quota_exceeded);
  store.addOneShotAttachment({
    type: 'annotated_capture',
    source_url: sourceUrl,
    image_path: saved.rel_path,
    user_note: userNote.trim() || `${defaultNotePrefix} (${sourceUrl})`,
  });

  useWorkspaceStore.setState({ rightCollapsed: false, zenMode: false });
  onSentToChat();
  return saved.rel_path;
}

export interface AnnotationCanvasProps {
  snapshotDataUrl: string | null;
  sourceUrl: string;
  width: number;
  height: number;
  onCancel: () => void;
  onSentToChat: () => void;
}

export const AnnotationCanvas: React.FC<AnnotationCanvasProps> = ({
  snapshotDataUrl,
  sourceUrl,
  width,
  height,
  onCancel,
  onSentToChat,
}) => {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [tool, setTool] = useState<AnnotationTool>('pen');
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState<number>(4);
  const [calloutText, setCalloutText] = useState<string>('');
  const [userNote, setUserNote] = useState<string>('');
  const [operations, setOperations] = useState<AnnotationOp[]>([]);
  const [draftOp, setDraftOp] = useState<AnnotationOp | null>(null);
  const [baseImageUrl, setBaseImageUrl] = useState<string | null>(snapshotDataUrl);
  const [baseImage, setBaseImage] = useState<HTMLImageElement | null>(null);
  const [sending, setSending] = useState<boolean>(false);
  const [inlineTextPos, setInlineTextPos] = useState<AnnotationPoint | null>(null);
  const [inlineTextValue, setInlineTextValue] = useState<string>('');

  const canvasW = Math.max(320, Math.round(width));
  const canvasH = Math.max(200, Math.round(height));

  useEffect(() => {
    setBaseImageUrl(snapshotDataUrl);
  }, [snapshotDataUrl]);

  useEffect(() => {
    if (!baseImageUrl) {
      setBaseImage(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) {
        setBaseImage(img);
      }
    };
    img.onerror = () => {
      if (!cancelled) {
        setBaseImage(null);
      }
    };
    img.src = baseImageUrl;
    return () => {
      cancelled = true;
    };
  }, [baseImageUrl]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderAnnotationScene(ctx, canvasW, canvasH, baseImage, sourceUrl, operations, draftOp);
  }, [canvasW, canvasH, baseImage, sourceUrl, operations, draftOp]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // Support Ctrl+Z (Undo) and Ctrl+V (paste base image)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        setOperations((prev) => prev.slice(0, -1));
      } else if (e.key === 'Escape') {
        if (inlineTextPos) {
          setInlineTextPos(null);
          setInlineTextValue('');
        } else {
          onCancel();
        }
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              setBaseImageUrl(reader.result);
            }
          };
          reader.readAsDataURL(file);
          e.preventDefault();
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', handlePaste);
    };
  }, [inlineTextPos, onCancel]);

  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): AnnotationPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvasW / rect.width : 1;
    const scaleY = rect.height > 0 ? canvasH / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const pt = getCanvasPoint(e);

    if (tool === 'text') {
      const text = calloutText.trim();
      if (text) {
        setOperations((prev) => [
          ...prev,
          { kind: 'text', color, strokeWidth, x: pt.x, y: pt.y, text },
        ]);
      } else {
        setInlineTextPos(pt);
        setInlineTextValue('');
      }
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'pen') {
      setDraftOp({ kind: 'pen', color, strokeWidth, points: [pt] });
    } else if (tool === 'rect') {
      setDraftOp({ kind: 'rect', color, strokeWidth, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
    } else if (tool === 'arrow') {
      setDraftOp({ kind: 'arrow', color, strokeWidth, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draftOp) return;
    const pt = getCanvasPoint(e);
    if (draftOp.kind === 'pen') {
      setDraftOp({ ...draftOp, points: [...draftOp.points, pt] });
    } else if (draftOp.kind === 'rect' || draftOp.kind === 'arrow') {
      setDraftOp({ ...draftOp, x2: pt.x, y2: pt.y });
    }
  };

  const commitDraft = () => {
    if (!draftOp) return;
    setOperations((prev) => [...prev, draftOp]);
    setDraftOp(null);
  };

  const handleCommitInlineText = () => {
    if (inlineTextPos && inlineTextValue.trim()) {
      setOperations((prev) => [
        ...prev,
        {
          kind: 'text',
          color,
          strokeWidth,
          x: inlineTextPos.x,
          y: inlineTextPos.y,
          text: inlineTextValue.trim(),
        },
      ]);
    }
    setInlineTextPos(null);
    setInlineTextValue('');
  };

  const handleUploadImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setBaseImageUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSendToChat = async () => {
    if (sending) return;
    setSending(true);
    try {
      redraw();
      await sendAnnotatedCaptureToChat({
        canvas: canvasRef.current,
        sourceUrl,
        userNote,
        defaultNotePrefix: t('browser.annotationDefaultNote'),
        onSentToChat,
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="annotation-canvas-overlay">
      <div className="annotation-toolbar">
        <span className="annotation-banner-badge">{t('browser.annotationBanner')}</span>

        <div className="annotation-tool-group">
          <button
            type="button"
            className={`annotation-tool-btn ${tool === 'pen' ? 'active' : ''}`}
            onClick={() => setTool('pen')}
            title={t('browser.toolPen')}
          >
            <PenToolIcon size={14} />
            <span>{t('browser.toolPen')}</span>
          </button>
          <button
            type="button"
            className={`annotation-tool-btn ${tool === 'rect' ? 'active' : ''}`}
            onClick={() => setTool('rect')}
            title={t('browser.toolRect')}
          >
            <SquareIcon size={14} />
            <span>{t('browser.toolRect')}</span>
          </button>
          <button
            type="button"
            className={`annotation-tool-btn ${tool === 'arrow' ? 'active' : ''}`}
            onClick={() => setTool('arrow')}
            title={t('browser.toolArrow')}
          >
            <ArrowUpRightIcon size={14} />
            <span>{t('browser.toolArrow')}</span>
          </button>
          <button
            type="button"
            className={`annotation-tool-btn ${tool === 'text' ? 'active' : ''}`}
            onClick={() => setTool('text')}
            title={t('browser.toolText')}
          >
            <TypeIcon size={14} />
            <span>{t('browser.toolText')}</span>
          </button>
        </div>

        {tool === 'text' && (
          <input
            type="text"
            className="annotation-text-input"
            value={calloutText}
            onChange={(e) => setCalloutText(e.target.value)}
            placeholder={t('browser.textPlaceholder')}
          />
        )}

        <div className="annotation-swatch-group">
          {ANNOTATION_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={`color-swatch-btn ${color === swatch ? 'active' : ''}`}
              style={{ backgroundColor: swatch }}
              onClick={() => setColor(swatch)}
              aria-label={swatch}
            />
          ))}
          <input
            type="color"
            className="annotation-color-picker"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-label="Custom color"
          />
        </div>

        <div className="annotation-stroke-group">
          {ANNOTATION_STROKE_WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              className={`stroke-pill ${strokeWidth === w ? 'active' : ''}`}
              onClick={() => setStrokeWidth(w)}
            >
              {w}px
            </button>
          ))}
        </div>

        <div className="annotation-action-group">
          <button
            type="button"
            className="annotation-tool-btn"
            onClick={() => setOperations((prev) => prev.slice(0, -1))}
            disabled={operations.length === 0}
            title={t('browser.undo')}
          >
            <UndoIcon size={14} />
            <span>{t('browser.undo')}</span>
          </button>
          <button
            type="button"
            className="annotation-tool-btn"
            onClick={() => setOperations([])}
            disabled={operations.length === 0}
            title={t('browser.clear')}
          >
            <TrashIcon size={14} />
            <span>{t('browser.clear')}</span>
          </button>
          <button
            type="button"
            className="annotation-tool-btn"
            onClick={() => fileInputRef.current?.click()}
            title={t('browser.pasteOrUploadImage')}
          >
            <ImageIcon size={14} />
            <span>{t('browser.pasteOrUploadImage')}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleUploadImage}
          />
        </div>
      </div>

      <div className="annotation-stage">
        <canvas
          ref={canvasRef}
          width={canvasW}
          height={canvasH}
          className="annotation-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={commitDraft}
          onPointerCancel={commitDraft}
        />

        {inlineTextPos && (
          <input
            type="text"
            autoFocus
            className="annotation-inline-input"
            style={{
              left: `${Math.min(85, (inlineTextPos.x / canvasW) * 100)}%`,
              top: `${Math.min(85, (inlineTextPos.y / canvasH) * 100)}%`,
              borderColor: color,
            }}
            value={inlineTextValue}
            onChange={(e) => setInlineTextValue(e.target.value)}
            placeholder={t('browser.textPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCommitInlineText();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setInlineTextPos(null);
                setInlineTextValue('');
              }
            }}
            onBlur={handleCommitInlineText}
          />
        )}
      </div>

      <div className="annotation-footer">
        <input
          type="text"
          className="annotation-note-input"
          value={userNote}
          onChange={(e) => setUserNote(e.target.value)}
          placeholder={t('browser.notePlaceholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSendToChat();
            }
          }}
        />
        <button
          type="button"
          className="btn-secondary"
          onClick={onCancel}
          disabled={sending}
        >
          <CloseIcon size={14} />
          <span>{t('browser.cancelAnnotation')}</span>
        </button>
        <button
          type="button"
          className="btn-primary annotation-send-btn"
          onClick={() => void handleSendToChat()}
          disabled={sending}
        >
          <SendIcon size={14} />
          <span>{sending ? t('browser.sendingToChat') : t('browser.sendToChat')}</span>
        </button>
      </div>
    </div>
  );
};
