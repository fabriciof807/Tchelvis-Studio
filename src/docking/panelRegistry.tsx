import type { IDockviewPanelProps } from 'dockview-react';
import { MarkdownPanel, type MarkdownPanelParams } from '../panels/MarkdownPanel';
import { LoopsPanel, type LoopsPanelParams } from '../panels/LoopsPanel';
import { TerminalPanel } from '../panels/TerminalPanel';
import { CustomLensPanel, type CustomLensPanelParams } from '../panels/CustomLensPanel';
import { MediaViewerPanel, type MediaViewerPanelParams } from '../panels/MediaViewerPanel';
import { BrowserPanel, type BrowserPanelParams } from '../panels/BrowserPanel';

export const PANEL_COMPONENTS: Record<string, React.FC<IDockviewPanelProps<any>>> = {
  markdown: MarkdownPanel as React.FC<IDockviewPanelProps<MarkdownPanelParams>>,
  loops: LoopsPanel as React.FC<IDockviewPanelProps<LoopsPanelParams>>,
  terminal: TerminalPanel as React.FC<IDockviewPanelProps>,
  lens: CustomLensPanel as React.FC<IDockviewPanelProps<CustomLensPanelParams>>,
  media: MediaViewerPanel as React.FC<IDockviewPanelProps<MediaViewerPanelParams>>,
  browser: BrowserPanel as React.FC<IDockviewPanelProps<BrowserPanelParams>>,
};
