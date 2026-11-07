// ═══════════════════════════════════════════════
// LEGAL ANNOTATOR SERVICE WORKER
// Network-First with Cache Fallback for Offline Study
// ═══════════════════════════════════════════════

const CACHE_NAME = 'legal-annotator-shell-v130';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './pen-debug.html',
  './favicon.ico',
  './icon-32.png',
  './icon-64.png',
  './icon-192.png',
  './icon-512.png',
  './ellen.png',
  './remielle.gif',
  './thinking.gif',
  './icon.svg',
  './src/style.css',
  './src/main.js',
  './src/storage.js',
  './src/offline.js',
  './src/export.js',
  './src/annotate.js',
  './src/viewer.js',
  './src/db.js',
  './src/drive.js',
  './src/library.js',
  './src/ui.js',
  './src/state.js',
  './src/colors.js',
  './src/draw.js',
  './src/dualview.js',
  './src/sync.js',
  './src/backup.js',
  './src/search.js',
  './src/tablepicker.js',
  './src/notepad.js',
  './src/pdfcache.js',
  './src/outbox.js',
  './src/diag.js',
  './src/diagram.js',
  './src/pdflink.js',
  './src/pen.js',
  './src/panel-find.js',
  './src/ai.js',
  './src/goodnotes-ui.js',
  './src/ocr.js',
  './src/ocr-studio.js',
  './src/schedule.js',
  './src/smart-copy.js',
  './src/syllabus.js',
  './src/tags.js',
  './src/thumbnails.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
  'https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap'
];

// ── Install: Pre-cache core app shell & activate immediately ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Use individual try/catch so one CDN delay doesn't block the entire install
      for (const asset of STATIC_ASSETS) {
        try {
          await cache.add(asset);
        } catch (e) {
          console.warn('[ServiceWorker] Pre-cache skipped for:', asset, e);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: Purge old cache versions ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[ServiceWorker] Purging old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ── Fetch: Network-First with Cache Fallback ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Never intercept Google OAuth or Supabase backend API calls
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('google.com') ||
    url.hostname.includes('supabase.co')
  ) {
    return; // Pass through to network
  }

  // 2. Non-GET requests (e.g. POST, PUT, DELETE) pass directly
  if (event.request.method !== 'GET') {
    return;
  }

  // 3. Network-First for app code & assets
  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // If response is valid, update the cache in background
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        // Network failed (device is offline) — serve from cache
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }
        // If navigating to a page offline, fallback to index.html
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html') || caches.match('./');
        }
        return new Response('Offline and resource not cached.', {
          status: 503,
          statusText: 'Service Unavailable'
        });
      })
  );
});
