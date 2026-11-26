import React, { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ipc } from '../types/ipc';
import { useI18n } from '../i18n/useI18n';
import {
  BoxIcon,
  GridIcon,
  ImageIcon,
  RefreshIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '../components/Icons';
import {
  base64ToUint8Array,
  getFileExtension,
  getMediaKind,
  getMimeTypeForExt,
  type MediaKind,
} from './mediaUtils';
import {
  BUTTON_STEP,
  fitTransform,
  formatZoomLabel,
  isPixelated,
  oneToOne,
  panBy,
  wheelFactor,
  zoomAt,
  type Point,
  type Size,
  type ViewState,
  type ViewportBounds,
} from './imageViewport';

export interface MediaViewerPanelParams {
  relPath: string;
  mediaKind?: MediaKind;
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        const record = mat as unknown as Record<string, unknown>;
        for (const val of Object.values(record)) {
          if (val && typeof val === 'object' && 'isTexture' in val) {
            (val as THREE.Texture).dispose();
          }
        }
        mat.dispose();
      }
    }
  });
}

function countStats(root: THREE.Object3D): { meshes: number; triangles: number } {
  let meshes = 0;
  let triangles = 0;
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      meshes += 1;
      const geom = mesh.geometry;
      if (geom.index) {
        triangles += Math.floor(geom.index.count / 3);
      } else if (geom.attributes.position) {
        triangles += Math.floor(geom.attributes.position.count / 3);
      }
    }
  });
  return { meshes, triangles };
}

function setWireframe(root: THREE.Object3D, enabled: boolean) {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (mat && 'wireframe' in mat) {
          (mat as THREE.MeshStandardMaterial).wireframe = enabled;
        }
      }
    }
  });
}

async function parseModel3D(ext: string, bytes: Uint8Array): Promise<THREE.Object3D> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader();
    return await new Promise<THREE.Object3D>((resolve, reject) => {
      loader.parse(
        ext === 'gltf' ? new TextDecoder().decode(bytes) : buffer,
        '',
        (gltf) => resolve(gltf.scene),
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      );
    });
  }

  if (ext === 'obj') {
    const loader = new OBJLoader();
    const text = new TextDecoder().decode(bytes);
    const obj = loader.parse(text);
    obj.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (!mesh.material || (Array.isArray(mesh.material) && mesh.material.length === 0)) {
          mesh.material = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.6, metalness: 0.15 });
        }
      }
    });
    return obj;
  }

  if (ext === 'stl') {
    const loader = new STLLoader();
    const geometry = loader.parse(buffer);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.5, metalness: 0.25 });
    return new THREE.Mesh(geometry, material);
  }

  if (ext === 'fbx') {
    const loader = new FBXLoader();
    return loader.parse(buffer, '');
  }

  throw new Error(`Unsupported 3D format: .${ext}`);
}

const measureStage = (el: HTMLElement | null): Size => ({
  w: el?.clientWidth ?? 0,
  h: el?.clientHeight ?? 0,
});

/** Exported for tests only; panels use `MediaViewerPanel`. */
export const ImageViewer: React.FC<{ relPath: string }> = ({ relPath }) => {
  const { t } = useI18n();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewState | null>(null);
  const [imageSize, setImageSize] = useState<Size | null>(null);
  const [checkerboard, setCheckerboard] = useState(true);
  const [panning, setPanning] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageSizeRef = useRef<Size | null>(null);
  const dragRef = useRef<Point | null>(null);

  const currentBounds = (): ViewportBounds | null => {
    const image = imageSizeRef.current;
    if (!image) return null;
    return { stage: measureStage(stageRef.current), image };
  };

  const zoomBy = (factor: number) => {
    const bounds = currentBounds();
    if (!bounds) return;
    const anchor = { x: bounds.stage.w / 2, y: bounds.stage.h / 2 };
    setView((prev) => (prev ? zoomAt(prev, factor, anchor, bounds) : prev));
  };

  const applyFit = () => {
    const bounds = currentBounds();
    setView(bounds ? fitTransform(bounds) : { scale: 1, x: 0, y: 0, mode: 'fit' });
  };

  const applyOneToOne = () => {
    const bounds = currentBounds();
    if (!bounds) return;
    setView((prev) => (prev ? oneToOne(prev, bounds) : prev));
  };

  const handleLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    const size = { w: img.naturalWidth, h: img.naturalHeight };
    imageSizeRef.current = size;
    setImageSize(size);
    setView(fitTransform({ stage: measureStage(stageRef.current), image: size }));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    const el = stageRef.current;
    try {
      el?.setPointerCapture?.(event.pointerId);
    } catch {
      // older engines / jsdom without pointer capture
    }
    dragRef.current = { x: event.clientX, y: event.clientY };
    setPanning(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const last = dragRef.current;
    if (!last) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    dragRef.current = { x: event.clientX, y: event.clientY };
    if (dx === 0 && dy === 0) return;
    const bounds = currentBounds();
    if (!bounds) return;
    setView((prev) => (prev ? panBy(prev, dx, dy, bounds) : prev));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPanning(false);
    const el = stageRef.current;
    try {
      el?.releasePointerCapture?.(event.pointerId);
    } catch {
      // older engines / jsdom without pointer capture
    }
  };

  const preventMiddleButtonDefault = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) event.preventDefault();
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const refit = () => {
      const image = imageSizeRef.current;
      if (!image) return;
      const stage = measureStage(el);
      setView((prev) => (prev && prev.mode === 'fit' ? fitTransform({ stage, image }) : prev));
    };
    refit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = currentBounds();
      if (!bounds) return;
      const rect = el.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = wheelFactor(event.deltaY, event.deltaMode);
      setView((prev) => (prev ? zoomAt(prev, factor, anchor, bounds) : prev));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // Current view/bounds are read through refs, so the listener never goes stale.
  }, []);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    setView(null);
    setImageSize(null);
    setPanning(false);
    imageSizeRef.current = null;
    dragRef.current = null;

    void ipc
      .readBinaryFile(relPath)
      .then((b64) => {
        if (cancelled) return;
        const ext = getFileExtension(relPath);
        const bytes = base64ToUint8Array(b64);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const blob = new Blob([copy.buffer], { type: getMimeTypeForExt(ext) });
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [relPath]);

  const zoomLabel = view ? formatZoomLabel(view, t('media.fit')) : t('media.fit');

  return (
    <div className="panel-shell">
      <div className="panel-toolbar">
        <div className="panel-toolbar-left">
          <span className="sandbox-badge inline-icon-text">
            <ImageIcon size={12} />
            <span>{t('media.imageMode')}</span>
          </span>
          <span className="file-badge" title={relPath}>
            {relPath}
          </span>
          {imageSize && (
            <span className="muted-text">
              {imageSize.w} × {imageSize.h}px
            </span>
          )}
        </div>
        <div className="panel-toolbar-right">
          <button
            type="button"
            className="btn-ghost-sm inline-icon-btn"
            onClick={() => zoomBy(1 / BUTTON_STEP)}
            title={t('media.zoomOut')}
          >
            <ZoomOutIcon size={13} />
          </button>
          <span className="file-badge image-zoom-label">{zoomLabel}</span>
          <button
            type="button"
            className="btn-ghost-sm inline-icon-btn"
            onClick={() => zoomBy(BUTTON_STEP)}
            title={t('media.zoomIn')}
          >
            <ZoomInIcon size={13} />
          </button>
          <button type="button" className="btn-ghost-sm" onClick={applyFit}>
            {t('media.fit')}
          </button>
          <button type="button" className="btn-ghost-sm" onClick={applyOneToOne}>
            1:1
          </button>
          <button
            type="button"
            className={checkerboard ? 'btn-primary-sm' : 'btn-ghost-sm'}
            onClick={() => setCheckerboard((c) => !c)}
          >
            {t('media.checkerboard')}
          </button>
        </div>
      </div>

      {error && <div className="banner-error">{error}</div>}

      <div
        ref={stageRef}
        className={`media-image-stage ${checkerboard ? 'media-checkerboard' : ''}${
          panning ? ' is-panning' : ''
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onMouseDown={preventMiddleButtonDefault}
        onAuxClick={preventMiddleButtonDefault}
      >
        {loading && <div className="panel-empty">{t('media.loading')}</div>}
        {!loading && blobUrl && (
          <img
            src={blobUrl}
            alt={relPath}
            draggable={false}
            className={`media-image-scaled${
              view && isPixelated(view.scale) ? ' media-image-pixelated' : ''
            }`}
            style={
              view
                ? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }
                : undefined
            }
            onLoad={handleLoad}
          />
        )}
      </div>
    </div>
  );
};

const Model3DViewer: React.FC<{ relPath: string }> = ({ relPath }) => {
  const { t } = useI18n();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const initialCamPosRef = useRef<THREE.Vector3>(new THREE.Vector3(3, 2, 4));
  const initialTargetRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, 0));
  const modelRootRef = useRef<THREE.Object3D | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const autoRotateRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wireframe, setWireframeState] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [stats, setStats] = useState<{ meshes: number; triangles: number } | null>(null);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate;
    }
  }, [autoRotate]);

  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.visible = showGrid;
    }
  }, [showGrid]);

  useEffect(() => {
    if (modelRootRef.current) {
      setWireframe(modelRootRef.current, wireframe);
    }
  }, [wireframe]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let cancelled = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let animId = 0;

    setLoading(true);
    setError(null);
    setStats(null);

    let scene: THREE.Scene;
    let camera: THREE.PerspectiveCamera;
    let controls: OrbitControls;

    try {
      scene = new THREE.Scene();
      scene.background = new THREE.Color('#0f1219');

      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 2000);
      camera.position.set(3, 2, 4);
      cameraRef.current = camera;

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      container.innerHTML = '';
      container.appendChild(renderer.domElement);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.autoRotate = autoRotateRef.current;
      controls.autoRotateSpeed = 1.6;
      controlsRef.current = controls;

      const hemiLight = new THREE.HemisphereLight(0xe2e8f0, 0x1e293b, 1.1);
      scene.add(hemiLight);

      const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
      keyLight.position.set(5, 10, 7);
      scene.add(keyLight);

      const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.65);
      fillLight.position.set(-6, 4, -5);
      scene.add(fillLight);

      const grid = new THREE.GridHelper(10, 20, 0x3b82f6, 0x272e3f);
      grid.visible = showGrid;
      gridRef.current = grid;
      scene.add(grid);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('media.webglUnsupported'));
      setLoading(false);
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!container || !renderer) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w <= 0 || h <= 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    const animate = () => {
      animId = window.requestAnimationFrame(animate);
      controls.update();
      renderer?.render(scene, camera);
    };
    animate();

    void ipc
      .readBinaryFile(relPath)
      .then(async (b64) => {
        if (cancelled) return;
        const ext = getFileExtension(relPath);
        const bytes = base64ToUint8Array(b64);
        const object = await parseModel3D(ext, bytes);
        if (cancelled) {
          disposeObject3D(object);
          return;
        }

        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.001);

        object.position.sub(center);
        object.position.y += size.y / 2;

        const target = new THREE.Vector3(0, size.y / 2, 0);
        const dist = maxDim * 1.75;
        const camPos = new THREE.Vector3(dist * 0.85, Math.max(size.y * 0.8, dist * 0.5), dist * 0.85);

        camera.position.copy(camPos);
        camera.near = Math.max(0.001, dist / 500);
        camera.far = Math.max(100, dist * 50);
        camera.updateProjectionMatrix();
        controls.target.copy(target);
        controls.update();

        initialCamPosRef.current.copy(camPos);
        initialTargetRef.current.copy(target);

        if (gridRef.current) {
          const gridScale = Math.max(0.5, Math.ceil(maxDim * 2) / 10);
          gridRef.current.scale.setScalar(gridScale);
        }

        modelRootRef.current = object;
        setWireframe(object, wireframe);
        scene.add(object);
        setStats(countStats(object));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      controls.dispose();
      if (modelRootRef.current) {
        disposeObject3D(modelRootRef.current);
        modelRootRef.current = null;
      }
      gridRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      renderer?.dispose();
    };
  }, [relPath, t]);

  const handleResetCamera = () => {
    if (!cameraRef.current || !controlsRef.current) return;
    cameraRef.current.position.copy(initialCamPosRef.current);
    controlsRef.current.target.copy(initialTargetRef.current);
    controlsRef.current.update();
  };

  return (
    <div className="panel-shell">
      <div className="panel-toolbar">
        <div className="panel-toolbar-left">
          <span className="sandbox-badge inline-icon-text">
            <BoxIcon size={12} />
            <span>{t('media.modelMode')}</span>
          </span>
          <span className="file-badge" title={relPath}>
            {relPath}
          </span>
          {stats && (
            <span className="muted-text">
              {t('media.stats', { meshes: stats.meshes, triangles: stats.triangles })}
            </span>
          )}
        </div>
        <div className="panel-toolbar-right">
          <button
            type="button"
            className="btn-ghost-sm inline-icon-btn"
            onClick={handleResetCamera}
          >
            <RefreshIcon size={12} />
            <span>{t('media.resetCamera')}</span>
          </button>
          <button
            type="button"
            className={`${showGrid ? 'btn-primary-sm' : 'btn-ghost-sm'} inline-icon-btn`}
            onClick={() => setShowGrid((g) => !g)}
          >
            <GridIcon size={12} />
            <span>{t('media.grid')}</span>
          </button>
          <button
            type="button"
            className={wireframe ? 'btn-primary-sm' : 'btn-ghost-sm'}
            onClick={() => setWireframeState((w) => !w)}
          >
            {t('media.wireframe')}
          </button>
          <button
            type="button"
            className={autoRotate ? 'btn-primary-sm' : 'btn-ghost-sm'}
            onClick={() => setAutoRotate((r) => !r)}
          >
            {t('media.autoRotate')}
          </button>
        </div>
      </div>

      {error && <div className="banner-error">{error}</div>}

      <div className="media-3d-wrapper">
        <div ref={mountRef} className="media-3d-canvas" />
        {loading && <div className="media-overlay-status">{t('media.loading')}</div>}
        {!loading && !error && <div className="media-3d-hint">{t('media.dragHint')}</div>}
      </div>
    </div>
  );
};

export const MediaViewerPanel: React.FC<IDockviewPanelProps<MediaViewerPanelParams>> = ({
  params,
}) => {
  const { t } = useI18n();
  const relPath = params.relPath;
  const kind = params.mediaKind ?? getMediaKind(relPath);

  if (kind === 'image') {
    return <ImageViewer relPath={relPath} />;
  }
  if (kind === 'model3d') {
    return <Model3DViewer relPath={relPath} />;
  }
  return (
    <div className="panel-empty">
      {t('media.unsupportedFormat', { ext: getFileExtension(relPath) || '?' })}
    </div>
  );
};
