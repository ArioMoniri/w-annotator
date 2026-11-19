import { initEngine, mountViewports, showImage, showMask, ORTHO_GROUP, BRUSH_INSTANCES } from './viewer/engine';
import { ToolGroupManager, Enums } from '@cornerstonejs/tools';

const root = document.getElementById('root')!;
root.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;width:100vw;height:100vh;gap:2px;background:#222';
document.body.style.margin = '0';
const els = ['axial', 'sagittal', 'coronal', 'volume3d'].map((id) => {
  const d = document.createElement('div');
  d.id = id;
  d.style.cssText = 'width:100%;height:100%;background:#000';
  d.oncontextmenu = (e) => e.preventDefault();
  root.appendChild(d);
  return d as HTMLDivElement;
});

(async () => {
  await initEngine();
  mountViewports({ axial: els[0], sagittal: els[1], coronal: els[2], volume3d: els[3] });
  const n = 64;
  const img = new Int16Array(n * n * n);
  const msk = new Uint8Array(n * n * n);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const r = Math.hypot(x - 32, y - 32, z - 32);
        img[z * n * n + y * n + x] = r < 24 ? 400 - r * 10 : -1000;
        if (Math.hypot(x - 40, y - 30, z - 32) < 8) msk[z * n * n + y * n + x] = 1;
      }
  const base = { name: 't', dims: [n, n, n] as [number, number, number], spacing: [1, 1, 2] as [number, number, number], origin: [0, 0, 0] as [number, number, number], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  await showImage({ ...base, data: img }, { lower: -200, upper: 400 });
  showMask({ ...base, data: msk });
  ToolGroupManager.getToolGroup(ORTHO_GROUP)!.setToolActive(BRUSH_INSTANCES.brush, { bindings: [{ mouseButton: Enums.MouseBindings.Primary }] });
  (window as any).__ready = true;
  (window as any).__msk = msk;
})().catch((e) => { console.error(e); (window as any).__err = String(e?.stack ?? e); });
