/**
 * Pet window preload — bridges the pet-view page to the main process.
 *
 * - setClickThrough(on): toggles window mouse-event pass-through for the
 *   transparent regions (the pet image itself stays interactive).
 * - moveWindow(dx, dy): moves the window by an offset (JS-driven dragging
 *   from the pet image only — the old whole-window -webkit-app-region drag
 *   made far-away empty space draggable).
 *
 * Sandboxed preloads may require('electron') for contextBridge/ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  setClickThrough: (on) => ipcRenderer.send('set-click-through', Boolean(on)),
  setForceInteractive: (on) => ipcRenderer.send('force-interactive', Boolean(on)),
  setHitRects: (rects) => ipcRenderer.send('hit-rects', rects),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', Number(dx) || 0, Number(dy) || 0),
  getPosition: () => ipcRenderer.invoke('get-position'),
  // 绘画作品：独立窗口显示在桌面右上角（不遮气泡）
  artworkOpen: (w, h) => ipcRenderer.send('artwork-open', Number(w) || 240, Number(h) || 240),
  artworkSet: (dataUrl) => ipcRenderer.send('artwork-set', String(dataUrl)),
  artworkClear: () => ipcRenderer.send('artwork-clear'),
  artworkFade: () => ipcRenderer.send('artwork-fade'),
  artworkClose: () => ipcRenderer.send('artwork-close'),
})
