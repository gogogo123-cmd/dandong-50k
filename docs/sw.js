'use strict';
// PWA 安装用的最小 Service Worker：不缓存，所有请求直连网络。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
