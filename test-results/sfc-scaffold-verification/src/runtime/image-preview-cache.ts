const DATABASE_NAME = 'sfc-image-preview-cache';
const DATABASE_VERSION = 1;
const STORE_NAME = 'previews';

export const IMAGE_CACHE_DISABLE_ATTRIBUTE = 'no-image-cache';
export const DEFAULT_IMAGE_CACHE_MAX_SIZE = 50 * 1024 * 1024;

interface PreviewEntry {
  url: string;
  blob: Blob;
  size: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  lastAccess: number;
}

export interface ImagePreviewCacheOptions {
  /** Maximum number of persisted preview bytes. Defaults to 50 MiB. */
  maxSize?: number;
}

export interface ImagePreviewCacheClearResult {
  entries: number;
  bytes: number;
}

interface ManagedImage {
  originalSrc: string;
  token: number;
  ignoreSrc: string | null;
  previewObjectUrl: string | null;
  addedDimensions: boolean;
}

const managedImages = new WeakMap<HTMLImageElement, ManagedImage>();
const rootObservers = new WeakMap<Node, MutationObserver>();
const pendingPreviews = new Map<string, Promise<void>>();
let configuredMaxSize = DEFAULT_IMAGE_CACHE_MAX_SIZE;
let databasePromise: Promise<IDBDatabase | null> | null = null;
let cacheGeneration = 0;

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction!.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: 'url' });
        if (!store.indexNames.contains('lastAccess')) {
          store.createIndex('lastAccess', 'lastAccess');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readPreview(url: string): Promise<PreviewEntry | null> {
  const database = await openDatabase();
  if (!database) return null;

  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const entry = await requestResult(
      transaction.objectStore(STORE_NAME).get(url) as IDBRequest<PreviewEntry>
    );
    if (!entry?.blob) return null;

    // Access timestamps are intentionally best-effort so a preview read never
    // waits for an LRU metadata write.
    try {
      const update = database.transaction(STORE_NAME, 'readwrite');
      update.objectStore(STORE_NAME).put({ ...entry, lastAccess: Date.now() });
    } catch {}
    return entry;
  } catch {
    return null;
  }
}

async function pruneCache(database: IDBDatabase): Promise<void> {
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const entries = await requestResult(
      transaction.objectStore(STORE_NAME).getAll() as IDBRequest<PreviewEntry[]>
    );
    if (!entries) return;

    let totalSize = entries.reduce((total, entry) => total + (entry.size || entry.blob?.size || 0), 0);
    if (totalSize <= configuredMaxSize) return;

    entries.sort((a, b) => a.lastAccess - b.lastAccess);
    const removal = database.transaction(STORE_NAME, 'readwrite');
    const store = removal.objectStore(STORE_NAME);
    for (const entry of entries) {
      if (totalSize <= configuredMaxSize) break;
      store.delete(entry.url);
      totalSize -= entry.size || entry.blob?.size || 0;
    }
  } catch {}
}

async function writePreview(entry: PreviewEntry): Promise<void> {
  if (entry.size > configuredMaxSize) return;
  const database = await openDatabase();
  if (!database) return;

  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(entry);
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
    await pruneCache(database);
  } catch {}
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, 'image/webp', 0.72);
    } catch {
      resolve(null);
    }
  });
}

async function resizeImage(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const width = Math.max(1, Math.round(sourceWidth / 4));
  const height = Math.max(1, Math.round(sourceHeight / 4));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  try {
    context.drawImage(source, 0, 0, width, height);
    const blob = await canvasToBlob(canvas);
    return blob ? { blob, width, height } : null;
  } catch {
    return null;
  }
}

async function createPreview(image: HTMLImageElement, url: string): Promise<void> {
  if (pendingPreviews.has(url)) return pendingPreviews.get(url)!;
  const generation = cacheGeneration;

  const task = (async () => {
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (!sourceWidth || !sourceHeight) return;

    let preview = await resizeImage(image, sourceWidth, sourceHeight);

    // A no-CORS <img> taints its canvas even when the host also supports CORS.
    // Retrying through fetch creates an origin-clean bitmap for cooperative
    // image hosts without changing the behavior of the visible element.
    if (!preview && typeof createImageBitmap === 'function') {
      try {
        const response = await fetch(url, {
          mode: 'cors',
          credentials: new URL(url).origin === location.origin ? 'same-origin' : 'omit'
        });
        if (response.ok) {
          const bitmap = await createImageBitmap(await response.blob());
          preview = await resizeImage(bitmap, bitmap.width, bitmap.height);
          bitmap.close();
        }
      } catch {
        // Cross-origin images without CORS permission keep normal loading
        // behavior and are simply not cached.
      }
    }

    if (!preview || generation !== cacheGeneration) return;
    await writePreview({
      url,
      blob: preview.blob,
      size: preview.blob.size,
      width: preview.width,
      height: preview.height,
      sourceWidth,
      sourceHeight,
      lastAccess: Date.now()
    });
  })().finally(() => pendingPreviews.delete(url));

  pendingPreviews.set(url, task);
  return task;
}

function absoluteImageUrl(src: string): string | null {
  try {
    const url = new URL(src, document.baseURI);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function assignManagedSrc(image: HTMLImageElement, state: ManagedImage, src: string): void {
  state.ignoreSrc = src;
  image.setAttribute('src', src);
}

function releasePreview(state: ManagedImage): void {
  if (!state.previewObjectUrl) return;
  URL.revokeObjectURL(state.previewObjectUrl);
  state.previewObjectUrl = null;
}

function addPreviewDimensions(image: HTMLImageElement, state: ManagedImage, entry: PreviewEntry): void {
  if (image.hasAttribute('width') || image.hasAttribute('height')) return;
  image.setAttribute('width', String(entry.sourceWidth || entry.width * 4));
  image.setAttribute('height', String(entry.sourceHeight || entry.height * 4));
  state.addedDimensions = true;
}

function releasePreviewDimensions(image: HTMLImageElement, state: ManagedImage): void {
  if (!state.addedDimensions) return;
  image.removeAttribute('width');
  image.removeAttribute('height');
  state.addedDimensions = false;
}

function restoreOriginal(image: HTMLImageElement, state: ManagedImage): void {
  releasePreview(state);
  releasePreviewDimensions(image, state);
  if (state.originalSrc) assignManagedSrc(image, state, state.originalSrc);
}

async function manageImage(image: HTMLImageElement): Promise<void> {
  let state = managedImages.get(image);
  if (!state) {
    const src = image.getAttribute('src') || '';
    state = {
      originalSrc: src,
      token: 0,
      ignoreSrc: null,
      previewObjectUrl: null,
      addedDimensions: false
    };
    managedImages.set(image, state);
  }

  const token = ++state.token;
  if (image.hasAttribute(IMAGE_CACHE_DISABLE_ATTRIBUTE)) {
    restoreOriginal(image, state);
    return;
  }

  const url = absoluteImageUrl(state.originalSrc);
  if (!url) {
    restoreOriginal(image, state);
    return;
  }

  const cached = await readPreview(url);
  if (state.token !== token || image.hasAttribute(IMAGE_CACHE_DISABLE_ATTRIBUTE)) return;

  if (cached) {
    releasePreview(state);
    const previewUrl = URL.createObjectURL(cached.blob);
    state.previewObjectUrl = previewUrl;
    addPreviewDimensions(image, state, cached);
    assignManagedSrc(image, state, previewUrl);

    const original = new Image();
    original.decoding = image.decoding;
    original.referrerPolicy = image.referrerPolicy;
    if (image.crossOrigin !== null) original.crossOrigin = image.crossOrigin;
    original.onload = () => {
      if (state!.token !== token) return;
      image.addEventListener('load', () => {
        if (state!.token !== token) return;
        releasePreview(state!);
        releasePreviewDimensions(image, state!);
      }, { once: true });
      assignManagedSrc(image, state!, state!.originalSrc);
    };
    original.src = state.originalSrc;
    return;
  }

  assignManagedSrc(image, state, state.originalSrc);
  const cacheLoadedImage = () => {
    if (state!.token === token) void createPreview(image, url);
  };
  if (image.complete && image.naturalWidth) cacheLoadedImage();
  else image.addEventListener('load', cacheLoadedImage, { once: true });
}

function imageElements(root: ParentNode): HTMLImageElement[] {
  const images = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
  if (root instanceof HTMLImageElement) images.unshift(root);
  return images;
}

/**
 * Removes image sources before a template fragment is connected. This gives an
 * IndexedDB preview a deterministic chance to render before the full image.
 */
export function stageImagePreviews(root: ParentNode): void {
  for (const image of imageElements(root)) {
    if (image.hasAttribute(IMAGE_CACHE_DISABLE_ATTRIBUTE)) continue;
    const src = image.getAttribute('src');
    if (!src) continue;
    managedImages.set(image, {
      originalSrc: src,
      token: 0,
      ignoreSrc: null,
      previewObjectUrl: null,
      addedDimensions: false
    });
    image.removeAttribute('src');
  }
}

function handleMutations(mutations: MutationRecord[]): void {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      for (const node of Array.from(mutation.removedNodes)) {
        if (!(node instanceof Element)) continue;
        for (const image of imageElements(node)) {
          const state = managedImages.get(image);
          if (!state) continue;
          state.token++;
          releasePreview(state);
          releasePreviewDimensions(image, state);
        }
      }
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof Element) {
          for (const image of imageElements(node)) void manageImage(image);
        }
      }
      continue;
    }

    const image = mutation.target;
    if (!(image instanceof HTMLImageElement)) continue;
    const state = managedImages.get(image);

    if (mutation.attributeName === IMAGE_CACHE_DISABLE_ATTRIBUTE) {
      if (state && image.hasAttribute(IMAGE_CACHE_DISABLE_ATTRIBUTE)) {
        state.token++;
        restoreOriginal(image, state);
      } else {
        if (state) state.originalSrc = image.getAttribute('src') || state.originalSrc;
        void manageImage(image);
      }
      continue;
    }

    const src = image.getAttribute('src') || '';
    if (state?.ignoreSrc === src) {
      state.ignoreSrc = null;
      continue;
    }
    if (state) {
      state.token++;
      releasePreview(state);
      releasePreviewDimensions(image, state);
      state.originalSrc = src;
    }
    void manageImage(image);
  }
}

/** Enables the built-in image preview behavior for an SFC render root. */
export function connectImagePreviewCache(root: Element | ShadowRoot): void {
  for (const image of imageElements(root)) void manageImage(image);
  if (rootObservers.has(root) || typeof MutationObserver === 'undefined') return;

  const observer = new MutationObserver(handleMutations);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', IMAGE_CACHE_DISABLE_ATTRIBUTE]
  });
  rootObservers.set(root, observer);
}

/**
 * Changes the persistent preview budget. Existing entries are evicted
 * asynchronously until the new maximum is met.
 */
export function configureImagePreviewCache(options: ImagePreviewCacheOptions): void {
  if (options.maxSize !== undefined) {
    if (!Number.isFinite(options.maxSize) || options.maxSize < 0) {
      throw new TypeError('image preview cache maxSize must be a non-negative number');
    }
    configuredMaxSize = Math.floor(options.maxSize);
    void openDatabase().then((database) => {
      if (database) void pruneCache(database);
    });
  }
}

function visibleManagedImages(): HTMLImageElement[] {
  if (typeof document === 'undefined') return [];
  const images = new Set<HTMLImageElement>();
  const visit = (root: Document | ShadowRoot) => {
    for (const image of Array.from(root.querySelectorAll('img'))) images.add(image);
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return [...images];
}

/**
 * Removes every persisted preview blob and releases previews currently shown
 * by connected images. In-flight preview jobs are invalidated before the
 * IndexedDB store is cleared, so they cannot repopulate it after this resolves.
 */
export async function clearImagePreviewCache(): Promise<ImagePreviewCacheClearResult> {
  cacheGeneration += 1;

  for (const image of visibleManagedImages()) {
    const state = managedImages.get(image);
    if (!state) continue;
    state.token += 1;
    restoreOriginal(image, state);
  }

  const database = await openDatabase();
  if (!database) return { entries: 0, bytes: 0 };

  try {
    const read = database.transaction(STORE_NAME, 'readonly');
    const cached = await requestResult(
      read.objectStore(STORE_NAME).getAll() as IDBRequest<PreviewEntry[]>
    ) || [];
    const bytes = cached.reduce((total, entry) => total + (entry.size || entry.blob?.size || 0), 0);
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
    return { entries: cached.length, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}
