(function() {
  'use strict';

  const ORIGIN = window.location.origin;
  const IS_EX = ORIGIN.includes('exhentai');

  const REGEX = {
    imageURL: [
      /<img id="img" src="(\S+?)"/,
      /<a href="(\S+?\/fullimg(?:\.php\?|\/)\S+?)"/,
      /<\/(?:script|iframe)><a[\s\S]+?><img src="(\S+?)"/
    ],
    nextFetchURL: [
      /<a id="next"[\s\S]+?href="(\S+?\/s\/\S+?)"/,
      /<a href="(\S+?\/s\/\S+?)"><img src="https?:\/\/ehgt\.org\/g\/n\.png"/
    ],
    nl: /return nl\('([\d\w-]+)'\)/,
    pagesLength: /<table class="ptt"[\s\S]+>(\d+)<\/a>[\s\S]*?<\/table>/,
    dangerChars: /[:"*?|<>\/\\\n]/g,
    banPage: /you are banned|image viewing limits|banned from|exceed your|too many/i,
    rateLimitPage: /slow down|rate limit|too fast|try again later|please wait/i,
  };

  let settings = {
    numberImages: false,
    numberSeparator: ': ',
    maxThreads: 3,
    retryCount: 3,
    delayBetweenImages: 800,
    saveAsCbz: false,
    autoStart: false,
    replaceDangerChars: true,
    savePageLinks: true,
    smartThrottle: true,
    maxDelay: 15000,
    banPauseMinutes: 5,
    downloadOriginal: false,
  };

  let isDownloading = false;
  let isPaused = false;
  let downloadAbort = false;
  let imageList = [];
  let imageData = [];
  let downloadedCount = 0;
  let failedCount = 0;
  let fetchCount = 0;
  let totalCount = 0;
  let retryCountMap = {};
  let pagesRange = [];
  let needNumberImages = false;
  let galleryTitle = '';
  let galleryGid = '';
  let galleryToken = '';

  // --- Rate Limit State ---
  let rateLimitState = {
    consecutive429: 0,
    consecutiveErrors: 0,
    totalErrors: 0,
    lastErrorTime: 0,
    currentDelay: settings.delayBetweenImages,
    banDetected: false,
    banUntil: 0,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    peakHourPenalty: false,
    adaptiveMultiplier: 1,
  };

  function isPeakHours() {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (day === 0) return hour >= 5 && hour < 20;
    return hour >= 14 && hour < 20;
  }

  function isRecentGallery() {
    const html = document.documentElement.innerHTML;
    const match = html.match(/Posted:<\/td><td[^>]*>(.*?)<\/td>/);
    if (!match) return false;
    const time = Date.parse(match[1].trim() + '+0000');
    return Date.now() - time < 90 * 24 * 60 * 60 * 1000;
  }

  function getGalleryAgeDays() {
    const html = document.documentElement.innerHTML;
    const match = html.match(/Posted:<\/td><td[^>]*>(.*?)<\/td>/);
    if (!match) return 999;
    const time = Date.parse(match[1].trim() + '+0000');
    return Math.floor((Date.now() - time) / (24 * 60 * 60 * 1000));
  }

  function calculateSmartDelay() {
    let base = settings.delayBetweenImages || 800;
    let delay = base;

    // Exponential backoff on consecutive errors
    if (rateLimitState.consecutiveErrors > 0) {
      const backoff = Math.min(
        rateLimitState.consecutiveErrors,
        6
      );
      delay = base * Math.pow(2, backoff);
      delay = Math.min(delay, settings.maxDelay || 15000);
    }

    // Extra penalty for 429s
    if (rateLimitState.consecutive429 > 0) {
      delay = Math.max(delay, 3000 * rateLimitState.consecutive429);
      delay = Math.min(delay, settings.maxDelay || 15000);
    }

    // Peak hours penalty
    if (isPeakHours()) {
      delay = Math.max(delay, delay * 1.5);
      rateLimitState.peakHourPenalty = true;
    } else {
      rateLimitState.peakHourPenalty = false;
    }

    // Recent gallery penalty (less than 30 days)
    if (isRecentGallery()) {
      delay = Math.max(delay, delay * 1.3);
    }

    // Adaptive multiplier based on success rate
    if (rateLimitState.totalRequests > 10) {
      const successRate = rateLimitState.successfulRequests / rateLimitState.totalRequests;
      if (successRate < 0.8) {
        rateLimitState.adaptiveMultiplier = Math.min(rateLimitState.adaptiveMultiplier * 1.2, 3);
      } else if (successRate > 0.95 && rateLimitState.adaptiveMultiplier > 1) {
        rateLimitState.adaptiveMultiplier = Math.max(rateLimitState.adaptiveMultiplier * 0.95, 1);
      }
      delay = Math.round(delay * rateLimitState.adaptiveMultiplier);
    }

    rateLimitState.currentDelay = delay;
    return delay;
  }

  function handleRateLimitResponse(status, responseText) {
    rateLimitState.totalRequests++;

    if (status === 429) {
      rateLimitState.consecutive429++;
      rateLimitState.consecutiveErrors++;
      rateLimitState.totalErrors++;
      rateLimitState.lastErrorTime = Date.now();
      const waitTime = Math.min(30000 * rateLimitState.consecutive429, 300000);
      log(`RATE LIMIT 429 detected! Waiting ${Math.round(waitTime/1000)}s before retry...`, 'error');
      updateRateLimitStatus();
      return { blocked: true, waitTime: waitTime };
    }

    if (status === 403 || status === 503) {
      rateLimitState.consecutiveErrors++;
      rateLimitState.totalErrors++;
      rateLimitState.lastErrorTime = Date.now();
      log(`Server error ${status}. Backing off...`, 'error');
      updateRateLimitStatus();
      return { blocked: true, waitTime: 5000 };
    }

    if (responseText && REGEX.banPage.test(responseText)) {
      rateLimitState.banDetected = true;
      rateLimitState.banUntil = Date.now() + (settings.banPauseMinutes || 5) * 60000;
      log(`BAN DETECTED! Pausing for ${settings.banPauseMinutes || 5} minutes...`, 'error');
      updateRateLimitStatus();
      return { blocked: true, waitTime: (settings.banPauseMinutes || 5) * 60000, isBan: true };
    }

    if (responseText && REGEX.rateLimitPage.test(responseText)) {
      rateLimitState.consecutiveErrors++;
      rateLimitState.totalErrors++;
      rateLimitState.lastErrorTime = Date.now();
      log(`Rate limit page detected. Backing off...`, 'error');
      updateRateLimitStatus();
      return { blocked: true, waitTime: 10000 };
    }

    // Success
    rateLimitState.consecutive429 = 0;
    rateLimitState.consecutiveErrors = 0;
    rateLimitState.successfulRequests++;
    updateRateLimitStatus();
    return { blocked: false };
  }

  function updateRateLimitStatus() {
    const el = document.getElementById('ehd-rate-status');
    if (!el) return;

    const parts = [];
    if (rateLimitState.banDetected && Date.now() < rateLimitState.banUntil) {
      const mins = Math.ceil((rateLimitState.banUntil - Date.now()) / 60000);
      parts.push(`BANNED - waiting ${mins}min`);
    }
    if (rateLimitState.peakHourPenalty) {
      parts.push('Peak hours (slower)');
    }
    if (rateLimitState.consecutive429 > 0) {
      parts.push(`429x${rateLimitState.consecutive429}`);
    }
    if (rateLimitState.consecutiveErrors > 0) {
      parts.push(`Errors: ${rateLimitState.consecutiveErrors}`);
    }
    if (rateLimitState.currentDelay > (settings.delayBetweenImages || 800)) {
      parts.push(`Delay: ${Math.round(rateLimitState.currentDelay/1000)}s`);
    }

    if (parts.length > 0) {
      el.textContent = 'Rate limit: ' + parts.join(' | ');
      el.style.display = 'block';
      el.style.color = '#8b2e2e';
    } else if (rateLimitState.totalRequests > 5) {
      const rate = Math.round((rateLimitState.successfulRequests / rateLimitState.totalRequests) * 100);
      el.textContent = `Status: ${rate}% success (${rateLimitState.successfulRequests}/${rateLimitState.totalRequests})`;
      el.style.display = 'block';
      el.style.color = rate > 90 ? '#2e6e3a' : '#8b6e1e';
    } else {
      el.style.display = 'none';
    }
  }

  function getGidAndToken() {
    const html = document.documentElement.innerHTML;
    const gidMatch = html.match(/var gid\s*=\s*(\d+)/);
    const tokenMatch = html.match(/var token\s*=\s*'([a-f0-9]+)'/);
    galleryGid = gidMatch ? gidMatch[1] : String(Date.now());
    galleryToken = tokenMatch ? tokenMatch[1] : '';
  }

  function getGalleryTitle() {
    const gn = document.getElementById('gn');
    const gj = document.getElementById('gj');
    if (gj && gj.textContent.trim()) return gj.textContent.trim();
    if (gn && gn.textContent.trim()) return gn.textContent.trim();
    return 'E-Hentai Gallery';
  }

  function sanitizeFilename(str) {
    if (!settings.replaceDangerChars) return str;
    return str.trim().replace(REGEX.dangerChars, '-').replace(/-{2,}/g, '-');
  }

  function getGalleryInfo() {
    let info = '';
    if (settings.savePageLinks) {
      const uploader = document.querySelector('#gdn');
      const category = document.querySelector('#gdc .cs');
      info += 'Title: ' + galleryTitle + '\n';
      if (uploader) info += 'Uploader: ' + uploader.textContent.trim() + '\n';
      if (category) info += 'Category: ' + category.textContent.trim() + '\n';
      info += 'URL: ' + window.location.href + '\n';
      info += 'GID: ' + galleryGid + '\n';
      const ageDays = getGalleryAgeDays();
      info += 'Gallery age: ' + ageDays + ' days\n';
      if (isPeakHours()) info += 'Note: Downloaded during peak hours\n';
      info += '\nImage List:\n';
    }
    return info;
  }

  function parseImageURL(html) {
    for (const regex of REGEX.imageURL) {
      const match = html.match(regex);
      if (match) return match[1];
    }
    return null;
  }

  function parseOriginalURL(html) {
    const m = html.match(REGEX.imageURL[1]);
    return m ? m[1] : null;
  }

  function parseNextURL(html) {
    for (const regex of REGEX.nextFetchURL) {
      const match = html.match(regex);
      if (match) return match[1];
    }
    return null;
  }

  function parseNL(html) {
    const match = html.match(REGEX.nl);
    if (match) return match[1];
    return null;
  }

  function parsePagesCount(html) {
    const match = html.match(REGEX.pagesLength);
    if (match) return parseInt(match[1], 10);
    return 1;
  }

  function isInPagesRange(pageNum) {
    if (!pagesRange || pagesRange.length === 0) return true;
    for (const range of pagesRange) {
      if (pageNum >= range[0] && pageNum <= range[1]) return true;
    }
    return false;
  }

  function parseRange(rangeStr) {
    if (!rangeStr || !rangeStr.trim()) return [];
    const parts = rangeStr.split(',').map(s => s.trim()).filter(Boolean);
    const result = [];
    for (const part of parts) {
      const match = part.match(/^(\d+)(?:-(\d+))?$/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : start;
        result.push([start, end]);
      }
    }
    return result;
  }

  function log(msg, type = '') {
    const logEl = document.getElementById('ehd-log');
    if (!logEl) return;
    logEl.style.display = 'block';
    const entry = document.createElement('div');
    entry.className = 'ehd-log-entry' + (type ? ' ' + type : '');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function updateStatus(msg) {
    const statusEl = document.getElementById('ehd-status');
    if (statusEl) statusEl.textContent = msg;
  }

  function updateProgress(current, total) {
    const container = document.getElementById('ehd-progress-container');
    const fill = document.getElementById('ehd-progress-fill');
    const text = document.getElementById('ehd-progress-text');
    if (!container || !fill || !text) return;
    container.style.display = 'block';
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    fill.style.width = pct + '%';
    text.textContent = `${current} / ${total} (${pct}%)`;
  }

  function enableButtons(downloading) {
    const startBtn = document.getElementById('ehd-start-btn');
    const pauseBtn = document.getElementById('ehd-pause-btn');
    const stopBtn = document.getElementById('ehd-stop-btn');
    const rangeInput = document.getElementById('ehd-range-input');
    if (startBtn) startBtn.disabled = downloading;
    if (pauseBtn) pauseBtn.disabled = !downloading;
    if (stopBtn) stopBtn.disabled = !downloading;
    if (rangeInput) rangeInput.disabled = downloading;
  }

  async function fetchPage(url) {
    const resp = await fetch(url, { credentials: 'same-origin' });
    const text = await resp.text();
    const rl = handleRateLimitResponse(resp.status, text);
    if (rl.blocked) {
      if (rl.isBan) {
        isPaused = true;
        updateStatus(`BANNED - auto-resuming in ${settings.banPauseMinutes || 5} min...`);
        await sleep(rl.waitTime);
        rateLimitState.banDetected = false;
        isPaused = false;
        updateStatus('Resuming after ban pause...');
      } else {
        await sleep(rl.waitTime);
      }
      throw new Error(`Rate limited (HTTP ${resp.status})`);
    }
    return text;
  }

  async function downloadImage(item) {
    const imageUrl = settings.downloadOriginal && item.originalURL ? item.originalURL : item.imageURL;
    const resp = await browser.runtime.sendMessage({
      type: 'FETCH_IMAGE',
      url: imageUrl,
      pageURL: item.pageURL,
      index: item.index
    });
    if (!resp.ok) throw new Error(resp.error || 'Fetch failed');
    const binaryStr = atob(resp.base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async function startDownload() {
    if (isDownloading) return;

    const rangeStr = document.getElementById('ehd-range-input')?.value || '';
    pagesRange = parseRange(rangeStr);
    needNumberImages = document.getElementById('ehd-number-check')?.checked || false;

    // Reset rate limit state
    rateLimitState = {
      consecutive429: 0, consecutiveErrors: 0, totalErrors: 0,
      lastErrorTime: 0, currentDelay: settings.delayBetweenImages,
      banDetected: false, banUntil: 0, totalRequests: 0,
      successfulRequests: 0, failedRequests: 0, peakHourPenalty: false,
      adaptiveMultiplier: 1,
    };

    isDownloading = true;
    isPaused = false;
    downloadAbort = false;
    downloadedCount = 0;
    failedCount = 0;
    fetchCount = 0;
    retryCountMap = {};
    imageList = [];
    imageData = [];

    enableButtons(true);

    // Pre-download warnings
    const ageDays = getGalleryAgeDays();
    const totalEst = parsePagesCount(document.documentElement.outerHTML);
    if (isPeakHours()) {
      log('PEAK HOURS active (14:00-20:00 UTC). Downloads will be slower.', 'error');
    }
    if (ageDays < 30) {
      log(`Recent gallery (${ageDays} days). Extra delay applied.`, 'info');
    }
    if (totalEst > 500) {
      log(`Large gallery (${totalEst} pages). Consider using page range.`, 'info');
    }
    if (IS_EX) {
      log('ExHentai detected. Higher rate limits apply.', 'info');
    }

    log(`Starting download (base delay: ${settings.delayBetweenImages}ms)...`, 'info');

    try {
      await collectAllPages();
      log(`Found ${imageList.length} images. Smart delay: ${Math.round(rateLimitState.currentDelay)}ms`, 'info');
      updateStatus(`Downloading ${imageList.length} images...`);

      await downloadAllImages();

      if (!downloadAbort) {
        log('All downloads complete. Creating ZIP...', 'info');
        updateStatus('Creating ZIP file...');
        await createAndSaveZip();
        log('Done! ZIP file saved.', 'success');
        updateStatus('Download complete!');
      }
    } catch (err) {
      log(`Error: ${err.message}`, 'error');
      updateStatus('Error: ' + err.message);
    }

    isDownloading = false;
    enableButtons(false);
    updateProgress(downloadedCount, totalCount);
  }

  async function collectFromGalleryPage() {
    const totalGalleryPages = parsePagesCount(document.documentElement.outerHTML) || 1;
    const baseURL = window.location.href.split('?')[0].split('#')[0];
    const linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']*\/s\/[^"']*)["'][^>]*>/gi;

    log(`Gallery detected, ${totalGalleryPages} page(s) of thumbnails.`, 'info');

    const html = document.documentElement.outerHTML;
    const gdt = document.getElementById('gdt');
    log(`#gdt found, innerHTML length: ${gdt ? gdt.innerHTML.length : 0}`, 'info');

    // Diagnostic: count ALL <a> tags and show some hrefs
    const allLinks = html.match(/<a\s[^>]*href\s*=\s*["'][^"']*["'][^>]*>/gi) || [];
    log(`Total <a> tags in HTML: ${allLinks.length}`, 'info');
    if (allLinks.length > 0) {
      const hrefs = allLinks.slice(0, 5).map(l => {
        const m = l.match(/href\s*=\s*["']([^"']*)["']/i);
        return m ? m[1] : 'no-href';
      });
      log(`First 5 hrefs: ${hrefs.join(', ')}`, 'info');
      log(`...last page href: ${(() => { const m = allLinks[allLinks.length - 1].match(/href\s*=\s*["']([^"']*)["']/i); return m ? m[1] : 'no-href'; })()}`, 'info');
    }

    let imagePageURLs = [];
    let seen = new Set();
    let idx = 1;

    const addURL = (url) => {
      if (!seen.has(url)) {
        seen.add(url);
        imagePageURLs.push({ url, index: idx++ });
      }
    };

    const extractLinks = (html) => {
      linkRegex.lastIndex = 0;
      let m;
      while ((m = linkRegex.exec(html)) !== null) addURL(resolveURL(m[1]));
    };

    extractLinks(html);
    log(`Current page: ${imagePageURLs.length} thumbnail (/s/) links found`, 'info');

    for (let p = 1; p < totalGalleryPages; p++) {
      if (downloadAbort) break;
      const pageURL = baseURL + '?p=' + p;
      let html;
      try {
        html = await fetchPage(pageURL);
      } catch (e) {
        log(`Failed gallery page ${p + 1}: ${e.message}`, 'error');
        break;
      }
      extractLinks(html);
    }

    totalCount = imagePageURLs.length;
    if (totalCount === 0) {
      log('No /s/ links via regex. Trying DOM fallback...', 'info');
      document.querySelectorAll('a[href*="/s/"]').forEach(a => addURL(a.href));
      totalCount = imagePageURLs.length;
      log(`DOM fallback: ${totalCount} links found`, 'info');
    }

    log(`Found ${totalCount} image pages total.`, 'info');
    updateProgress(0, totalCount);

    for (const { url, index: pageIdx } of imagePageURLs) {
      if (downloadAbort) break;
      if (!isInPagesRange(pageIdx)) continue;

      let retries = 0;
      let html = null;
      while (retries < 3) {
        try {
          html = await fetchPage(url);
          break;
        } catch (e) {
          retries++;
          log(`Retry image page ${pageIdx} (${retries}/3)...`, 'error');
          await sleep(calculateSmartDelay());
        }
      }

      if (!html) {
        log(`Failed image page ${pageIdx}, skipping...`, 'error');
        continue;
      }

      const imageURL = parseImageURL(html);
      const originalURL = parseOriginalURL(html);
      const nextURL = parseNextURL(html);
      const nl = parseNL(html);

      if (imageURL) {
        imageList.push({ pageURL: url, imageURL, originalURL, nextURL, nl, index: pageIdx });
      }

      await sleep(calculateSmartDelay() * 0.3);
    }

    totalCount = imageList.length;
    log(`Collected ${totalCount} image URLs.`, 'info');
    updateProgress(0, totalCount);
  }

  async function collectAllPages() {
    if (document.querySelector('#gdt')) {
      await collectFromGalleryPage();
      return;
    }

    const firstPageHTML = document.documentElement.outerHTML;
    const firstImageURL = parseImageURL(firstPageHTML);
    const firstNextURL = parseNextURL(firstPageHTML);
    const firstNL = parseNL(firstPageHTML);

    if (firstImageURL) {
      imageList.push({
        pageURL: window.location.href,
        imageURL: firstImageURL,
        nextURL: firstNextURL, nl: firstNL, index: 1
      });
    }

    if (imageList.length > 0 && !isInPagesRange(1)) {
      imageList.pop();
    }

    let currentURL = firstNextURL;
    let currentPage = 2;

    while (currentURL) {
      if (downloadAbort) break;

      if (!isInPagesRange(currentPage)) {
        currentPage++;
        try {
          const html = await fetchPage(resolveURL(currentURL));
          currentURL = parseNextURL(html);
          continue;
        } catch(e) { break; }
      }

      let retries = 0;
      let html = null;
      while (retries < 3) {
        try {
          html = await fetchPage(resolveURL(currentURL));
          break;
        } catch(e) {
          retries++;
          log(`Retry page ${currentPage} (${retries}/3)...`, 'error');
          await sleep(calculateSmartDelay());
        }
      }

      if (!html) {
        log(`Failed page ${currentPage}, skipping...`, 'error');
        currentURL = null;
        break;
      }

      const imageURL = parseImageURL(html);
      const originalURL = parseOriginalURL(html);
      const nextURL = parseNextURL(html);
      const nl = parseNL(html);

      if (imageURL) {
        imageList.push({
          pageURL: ORIGIN + '/s/' + currentURL.split('/s/')[1],
          imageURL, originalURL, nextURL, nl, index: currentPage
        });
      }

      currentURL = nextURL;
      currentPage++;
      await sleep(calculateSmartDelay() * 0.3);
    }

    totalCount = imageList.length;
    updateProgress(0, totalCount);
  }

  function resolveURL(url) {
    if (url.startsWith('http')) return url;
    if (url.startsWith('/')) return ORIGIN + url;
    return ORIGIN + '/' + url;
  }

  async function downloadAllImages() {
    const maxThreads = settings.maxThreads || 3;
    const queue = [...imageList];
    const workers = [];
    for (let i = 0; i < maxThreads; i++) {
      workers.push(processQueue(queue, i));
    }
    await Promise.all(workers);
  }

  async function processQueue(queue, workerId) {
    while (queue.length > 0) {
      if (downloadAbort) break;
      if (isPaused) {
        await sleep(500);
        continue;
      }
      // Check ban status
      if (rateLimitState.banDetected && Date.now() < rateLimitState.banUntil) {
        const waitMin = Math.ceil((rateLimitState.banUntil - Date.now()) / 60000);
        updateStatus(`Banned - waiting ${waitMin} min...`);
        await sleep(5000);
        continue;
      }

      const item = queue.shift();
      if (!item) break;

      fetchCount++;
      let retries = 0;
      let success = false;

      while (retries <= settings.retryCount && !success && !downloadAbort) {
        try {
          const buffer = await downloadImage(item);
          if (buffer && buffer.byteLength > 0) {
            imageData[item.index - 1] = buffer;
            downloadedCount++;
            success = true;
            const delay = calculateSmartDelay();
            log(`[${item.index}/${totalCount}] OK (${Math.round(delay)}ms delay)`, 'success');
          } else {
            throw new Error('Empty response');
          }
        } catch(err) {
          retries++;
          retryCountMap[item.index] = retries;
          if (retries <= settings.retryCount) {
            const delay = calculateSmartDelay();
            log(`[${item.index}/${totalCount}] Retry ${retries}/${settings.retryCount} (wait ${Math.round(delay/1000)}s): ${err.message}`, 'error');
            await sleep(delay);
          } else {
            failedCount++;
            rateLimitState.failedRequests++;
            log(`[${item.index}/${totalCount}] FAILED: ${err.message}`, 'error');
          }
        }
      }

      fetchCount--;
      updateProgress(downloadedCount + failedCount, totalCount);
      const remaining = totalCount - downloadedCount - failedCount;
      updateStatus(`${downloadedCount} OK | ${failedCount} fail | ${remaining} left | Delay: ${Math.round(rateLimitState.currentDelay/1000)}s`);

      await sleep(calculateSmartDelay());
    }
  }

  async function createAndSaveZip() {
    const zip = new JSZip();
    const title = sanitizeFilename(galleryTitle);
    let infoStr = getGalleryInfo();

    if (settings.savePageLinks) {
      for (let i = 0; i < imageList.length; i++) {
        const item = imageList[i];
        if (item) infoStr += `\nPage ${item.index}: ${item.pageURL}`;
      }
      infoStr += `\n\nDownloaded at ${new Date().toISOString()}`;
      infoStr += '\nGenerated by E-Hentai Downloader (Opera Extension)';
      infoStr += `\nStats: ${rateLimitState.successfulRequests}/${rateLimitState.totalRequests} requests succeeded`;
    }

    zip.file('info.txt', infoStr);

    for (let i = 0; i < imageList.length; i++) {
      if (imageData[i]) {
        let filename;
        if (needNumberImages) {
          const num = String(i + 1).padStart(3, '0');
          filename = num + settings.numberSeparator + (imageList[i].imageName || `image${i + 1}.jpg`);
        } else {
          filename = imageList[i].imageName || `image${i + 1}.jpg`;
        }
        zip.file(filename, imageData[i]);
      }
    }

    const content = await zip.generateAsync({
      type: 'base64', compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    try {
      const resp = await browser.runtime.sendMessage({
        type: 'DOWNLOAD_ZIP', zipBase64: content,
        fileName: title, saveAsCbz: settings.saveAsCbz
      });
      if (resp && !resp.ok) {
        log(`Save failed: ${resp.error}`, 'error');
      }
    } catch (e) {
      log(`Save error: ${e.message}`, 'error');
    }
    imageData = [];
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function pauseDownload() {
    isPaused = !isPaused;
    const pauseBtn = document.getElementById('ehd-pause-btn');
    if (pauseBtn) {
      pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('ehd-btn-primary', !isPaused);
      pauseBtn.classList.toggle('ehd-btn-success', isPaused);
    }
    log(isPaused ? 'Paused.' : 'Resumed.', 'info');
  }

  function stopDownload() {
    downloadAbort = true;
    isPaused = false;
    isDownloading = false;
    enableButtons(false);
    log('Aborted by user.', 'error');
    updateStatus('Aborted.');
  }

  function injectUI() {
    if (document.getElementById('ehd-box')) return;
    getGidAndToken();
    galleryTitle = getGalleryTitle();
    console.log('[EHD] Injecting UI for:', galleryTitle);

    const container = document.createElement('div');
    container.className = 'ehd-box';
    container.innerHTML = `
      <fieldset>
        <legend><img src="${browser.runtime.getURL('icons/icon16.png')}" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;image-rendering:pixelated;">E-Hentai Downloader</legend>

        <div class="ehd-actions">
          <button id="ehd-start-btn" class="ehd-btn ehd-btn-primary">Download Gallery</button>
          <button id="ehd-pause-btn" class="ehd-btn" disabled>Pause</button>
          <button id="ehd-stop-btn" class="ehd-btn ehd-btn-danger" disabled>Stop</button>
          <span style="color:#b2a89e">|</span>
          <label class="ehd-label">
            <input type="checkbox" id="ehd-number-check" ${settings.numberImages ? 'checked' : ''}>
            Number
          </label>
          <label class="ehd-label">
            Range:
            <input type="text" id="ehd-range-input" class="ehd-input" placeholder="1-5, 10-15" style="width:130px" disabled>
          </label>
          <span style="color:#b2a89e">|</span>
          <button id="ehd-settings-btn" class="ehd-btn">Settings</button>
          <button id="ehd-log-toggle" class="ehd-btn">Log</button>
        </div>

        <div id="ehd-rate-status" class="ehd-rate-status" style="display:none"></div>
        <div id="ehd-status" class="ehd-status">Ready</div>

        <div id="ehd-progress-container" class="ehd-progress-container">
          <div class="ehd-progress-bar">
            <div id="ehd-progress-fill" class="ehd-progress-fill"></div>
            <div id="ehd-progress-text" class="ehd-progress-text">0 / 0</div>
          </div>
        </div>

        <div id="ehd-settings-panel" class="ehd-settings-panel">
          <table style="width:100%;border-collapse:collapse">
            <tr>
              <td style="padding:2px 6px;font-size:11px;color:#555;white-space:nowrap">Threads:</td>
              <td style="padding:2px 6px"><input type="number" id="ehd-threads" class="ehd-input" value="${settings.maxThreads}" min="1" max="5"></td>
              <td style="padding:2px 6px;font-size:11px;color:#555;white-space:nowrap">Retries:</td>
              <td style="padding:2px 6px"><input type="number" id="ehd-retries" class="ehd-input" value="${settings.retryCount}" min="0" max="10"></td>
            </tr>
            <tr>
              <td style="padding:2px 6px;font-size:11px;color:#555;white-space:nowrap">Base delay (ms):</td>
              <td style="padding:2px 6px"><input type="number" id="ehd-delay" class="ehd-input" value="${settings.delayBetweenImages}" min="300" max="5000" step="100"></td>
              <td style="padding:2px 6px;font-size:11px;color:#555;white-space:nowrap">Max delay (ms):</td>
              <td style="padding:2px 6px"><input type="number" id="ehd-maxdelay" class="ehd-input" value="${settings.maxDelay}" min="5000" max="60000" step="1000"></td>
            </tr>
            <tr>
              <td style="padding:2px 6px;font-size:11px;color:#555;white-space:nowrap">Ban pause (min):</td>
              <td style="padding:2px 6px"><input type="number" id="ehd-banpause" class="ehd-input" value="${settings.banPauseMinutes}" min="1" max="30"></td>
              <td style="padding:2px 6px;font-size:11px;color:#555;white-space:nowrap">Separator:</td>
              <td style="padding:2px 6px"><input type="text" id="ehd-separator" class="ehd-input" value="${settings.numberSeparator}"></td>
            </tr>
          </table>
          <div style="margin-top:4px;display:flex;gap:14px;flex-wrap:wrap">
            <label class="ehd-label">
              <input type="checkbox" id="ehd-cbz-check" ${settings.saveAsCbz ? 'checked' : ''}>
              Save as .CBZ
            </label>
            <label class="ehd-label">
              <input type="checkbox" id="ehd-original-check" ${settings.downloadOriginal ? 'checked' : ''}>
              Original res
            </label>
            <label class="ehd-label">
              <input type="checkbox" id="ehd-safefile-check" ${settings.replaceDangerChars ? 'checked' : ''}>
              Safe filenames
            </label>
            <label class="ehd-label">
              <input type="checkbox" id="ehd-infolist-check" ${settings.savePageLinks ? 'checked' : ''}>
              Include info.txt
            </label>
          </div>
        </div>

        <div id="ehd-log" class="ehd-log"></div>
      </fieldset>
    `;

    // Insert panel after gallery info, before image grid
    const gdt = document.getElementById('gdt');
    const gm = document.querySelector('.gm');
    const gd2 = document.getElementById('gd2');
    const gd = document.getElementById('gd');

    if (gdt) {
      // Best: right before the image thumbnails
      gdt.parentNode.insertBefore(container, gdt);
    } else if (gm) {
      // Fallback: append at bottom of gallery container
      gm.appendChild(container);
    } else if (gd) {
      // Fallback: after gallery details
      gd.parentNode.insertBefore(container, gd.nextSibling);
    } else if (gd2) {
      // Last resort: after title, use insertAfter equivalent
      gd2.parentNode.insertBefore(container, gd2.nextSibling);
    } else {
      document.body.prepend(container);
    }

    document.getElementById('ehd-start-btn').addEventListener('click', startDownload);
    document.getElementById('ehd-pause-btn').addEventListener('click', pauseDownload);
    document.getElementById('ehd-stop-btn').addEventListener('click', stopDownload);
    document.getElementById('ehd-settings-btn').addEventListener('click', () => {
      const p = document.getElementById('ehd-settings-panel');
      p.style.display = p.style.display === 'block' ? 'none' : 'block';
    });
    document.getElementById('ehd-log-toggle').addEventListener('click', () => {
      const l = document.getElementById('ehd-log');
      l.style.display = l.style.display === 'block' ? 'none' : 'block';
    });

    document.getElementById('ehd-threads')?.addEventListener('change', (e) => {
      settings.maxThreads = Math.min(parseInt(e.target.value) || 3, 5);
      e.target.value = settings.maxThreads;
      saveSettings();
    });
    document.getElementById('ehd-retries')?.addEventListener('change', (e) => {
      settings.retryCount = parseInt(e.target.value) || 3;
      saveSettings();
    });
    document.getElementById('ehd-delay')?.addEventListener('change', (e) => {
      settings.delayBetweenImages = Math.max(parseInt(e.target.value) || 800, 300);
      e.target.value = settings.delayBetweenImages;
      saveSettings();
    });
    document.getElementById('ehd-maxdelay')?.addEventListener('change', (e) => {
      settings.maxDelay = parseInt(e.target.value) || 15000;
      saveSettings();
    });
    document.getElementById('ehd-banpause')?.addEventListener('change', (e) => {
      settings.banPauseMinutes = parseInt(e.target.value) || 5;
      saveSettings();
    });
    document.getElementById('ehd-separator')?.addEventListener('change', (e) => {
      settings.numberSeparator = e.target.value || ': ';
      saveSettings();
    });
    document.getElementById('ehd-cbz-check')?.addEventListener('change', (e) => {
      settings.saveAsCbz = e.target.checked;
      saveSettings();
    });
    document.getElementById('ehd-safefile-check')?.addEventListener('change', (e) => {
      settings.replaceDangerChars = e.target.checked;
      saveSettings();
    });
    document.getElementById('ehd-infolist-check')?.addEventListener('change', (e) => {
      settings.savePageLinks = e.target.checked;
      saveSettings();
    });
    document.getElementById('ehd-number-check')?.addEventListener('change', (e) => {
      settings.numberImages = e.target.checked;
      saveSettings();
    });
    document.getElementById('ehd-original-check')?.addEventListener('change', (e) => {
      settings.downloadOriginal = e.target.checked;
      saveSettings();
    });

    browser.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
      if (resp) { settings = resp; applySettingsToUI(); }
    });
  }

  function applySettingsToUI() {
    const el = (id) => document.getElementById(id);
    if (el('ehd-threads')) el('ehd-threads').value = settings.maxThreads;
    if (el('ehd-retries')) el('ehd-retries').value = settings.retryCount;
    if (el('ehd-delay')) el('ehd-delay').value = settings.delayBetweenImages;
    if (el('ehd-maxdelay')) el('ehd-maxdelay').value = settings.maxDelay;
    if (el('ehd-banpause')) el('ehd-banpause').value = settings.banPauseMinutes;
    if (el('ehd-separator')) el('ehd-separator').value = settings.numberSeparator;
    if (el('ehd-cbz-check')) el('ehd-cbz-check').checked = settings.saveAsCbz;
    if (el('ehd-safefile-check')) el('ehd-safefile-check').checked = settings.replaceDangerChars;
    if (el('ehd-infolist-check')) el('ehd-infolist-check').checked = settings.savePageLinks;
    if (el('ehd-number-check')) el('ehd-number-check').checked = settings.numberImages;
    if (el('ehd-original-check')) el('ehd-original-check').checked = settings.downloadOriginal;
  }

  function saveSettings() {
    browser.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: settings });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    injectUI();
  }
})();
